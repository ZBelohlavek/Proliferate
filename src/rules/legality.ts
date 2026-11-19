// A rules referee that watches a game and reports anything the Comprehensive Rules would not allow.
//
// The engine already builds every player's options itself and checks the answers it gets back, so a
// bot can only ever pick from what the engine offers. That makes the engine's offers the thing to
// check: this module looks at each decision before it is answered (is every offered action legal
// right now?), at each answer (is it one of the options, in range?), at every mana payment (were the
// sources really available, and do they pay the colors?), and at the game state between decisions
// (state-based actions done, commander damage, hand size, turn order, cards neither lost nor copied).
//
// It is written apart from the engine, from the rules, so that a mistake in the engine is not simply
// repeated here. Where it has to lean on the engine (power and toughness, keywords granted by other
// cards), it says so. Used by tests/legality.test.ts and the tools that play many games.

import type { SimCard, SimDeck } from '../engine/types';
import { Bot } from './bot';
import { cardColors, Game, isInstantSpeed, type GameOptions } from './game';
import type { Action, Answer, Decision, Perm, PlayerState, StackItem } from './types';

export interface Violation {
  /** Short rule tag, e.g. "cast-timing" or "commander-damage". */
  rule: string;
  /** Comprehensive Rules number the check comes from. */
  cr: string;
  msg: string;
  turn: number;
  seed?: number;
}

const STARTING_LIFE = 40;
const COMMANDER_DAMAGE = 21;

// The referee reaches into a few private helpers (payments, statics); typed loosely on purpose.
type AnyGame = any;

export class Referee {
  readonly violations: Violation[] = [];
  /** How many decisions, payments and turns were looked at. */
  readonly seen = { decisions: 0, payments: 0, turns: 0, casts: 0, attacks: 0, blocks: 0 };
  private lastActive = -1;
  private wasExtra = false;
  private openingChecked = false;
  private attackCheckedTurn = -1;
  private attackCheckedCombat = -1;
  private blockCheckedTurn = -1;
  private blockCheckedCombat = -1;
  /** The cast being made: the card, where from, and the commander tax owed. */
  private casting: { seat: number; card: SimCard; priced: SimCard; command: boolean; taxBefore: number; paid: number | null; stack: number; how?: string; reduction: number } | null = null;
  private readonly cardCounts: number[];
  private readonly g: AnyGame;

  constructor(readonly game: Game, readonly seed?: number) {
    this.g = game as unknown as AnyGame;
    this.cardCounts = game.players.map((p) => p.deck.cards.reduce((n, e) => n + e.count, 0) + p.deck.commanders.length);
    this.hookPayments();
    // 514.1: in the cleanup step, after discarding and before "until end of turn" effects end, the active player has at most their maximum hand size.
    const endOfTurn = this.g.endOfTurnControl.bind(this.g);
    this.g.endOfTurnControl = (p: PlayerState) => {
      const max = this.g.maxHandSize(p) as number;
      if (p.alive && p.hand.length > max && (this.g.statics(p, 'noMaxHand') as number) === 0) {
        this.flag('hand-size', '514.1', `${p.name} ends their turn with ${p.hand.length} cards in hand (maximum ${max})`);
      }
      return endOfTurn(p);
    };
    // Every turn, even one in which nobody is asked anything.
    const turn = this.g.turn.bind(this.g);
    const self = this;
    this.g.turn = function* (p: PlayerState) {
      self.checkTurn(p);
      return yield* turn(p);
    };
    for (const p of game.players) {
      if (p.life !== STARTING_LIFE) this.flag('starting-life', '903.7', `${p.name} starts at ${p.life} life`);
      if (p.commandZone.length !== p.deck.commanders.length) this.flag('command-zone', '903.6', `${p.name} starts with ${p.commandZone.length} cards in the command zone`);
    }
  }

  private readonly flagged = new Set<string>();

  /** Note a violation (once per rule and message: a broken state usually stays broken for a while). */
  private flag(rule: string, cr: string, msg: string) {
    const key = `${rule}|${msg}`;
    if (this.flagged.has(key)) return;
    this.flagged.add(key);
    this.violations.push({ rule, cr, msg, turn: this.game.turnNumber, seed: this.seed });
  }

  // -------------------------------------------------------------------------
  // Mana payments (rules 601.2g-h, 106, 302.6)
  // -------------------------------------------------------------------------

  private hookPayments() {
    const g = this.g;
    const plans = new WeakMap<object, { cost: { generic: number; pips: string[][] }; extra: number; reduction: number; ability: boolean }>();
    const planPayment = g.planPayment.bind(g);
    g.planPayment = (p: PlayerState, cost: any, extra: number, reduction: number, exclude?: Perm, ability = false) => {
      const plan = planPayment(p, cost, extra, reduction, exclude, ability);
      if (plan) plans.set(plan, { cost, extra, reduction, ability });
      return plan;
    };
    const commit = g.commitPayment.bind(g);
    g.commitPayment = (p: PlayerState, plan: Map<any, number>) => {
      this.seen.payments++;
      const info = plans.get(plan);
      this.checkPayment(p, plan, info);
      let units = 0;
      for (const u of plan.values()) units += u;
      if (this.casting && this.casting.seat === p.seat && this.casting.paid === null) {
        this.casting.paid = units;
        this.casting.how = [...plan].map(([src, n]) => `${n}×${src.perm?.card.name ?? (src.pool ? 'pool' : 'Treasure')}`).join(', ');
      }
      commit(p, plan);
    };
  }

  private checkPayment(p: PlayerState, plan: Map<any, number>, info: { cost: { generic: number; pips: string[][] }; extra: number; reduction: number; ability: boolean } | undefined) {
    const tapped = new Set<Perm>();
    let treasures = 0;
    const units: (string[] | 'any')[] = [];
    for (const [src, n] of plan) {
      if (n <= 0) continue;
      if (n > src.amount) this.flag('mana-amount', '106.4', `${p.name} takes ${n} mana from a source that makes ${src.amount}`);
      const perm: Perm | null = src.perm;
      if (perm) {
        // A source sacrificed as part of the same cost was tapped for mana first (rule 601.2g): only another player's permanent is wrong.
        if (!p.battlefield.includes(perm) && this.game.allPerms().includes(perm)) this.flag('mana-source', '106.4', `${p.name} pays with ${perm.card.name}, which they don't control`);
        const taps = !src.pool && !src.charge && !src.counters && !src.once && !src.sac;
        if (taps && p.battlefield.includes(perm)) {
          if (perm.tapped) this.flag('mana-tapped', '106.4', `${p.name} taps ${perm.card.name} for mana while it is already tapped`);
          if (tapped.has(perm)) this.flag('mana-tapped', '106.4', `${p.name} taps ${perm.card.name} twice in one payment`);
          tapped.add(perm);
          if (!perm.landInfo && perm.card.isCreature && perm.sick && !this.game.hasKw(perm, 'haste')) {
            this.flag('summoning-sick-mana', '302.6', `${p.name} taps ${perm.card.name} for mana the turn it came under their control`);
          }
        }
      } else if (!src.pool) {
        treasures++;
      } else if (src.pool.n < n) {
        this.flag('mana-pool', '106.4', `${p.name} spends ${n} from a pool holding ${src.pool.n}`);
      }
      for (let i = 0; i < n; i++) units.push(src.colors);
    }
    if (treasures > p.treasures) this.flag('mana-treasure', '111.10a', `${p.name} sacrifices ${treasures} Treasures but has ${p.treasures}`);
    if (!info) return;
    const pips = info.cost.pips;
    const generic = Math.max(0, info.cost.generic + info.extra - info.reduction);
    if (units.length < pips.length + generic) this.flag('mana-short', '601.2h', `${p.name} pays ${units.length} mana for a cost of ${pips.length + generic}`);
    if (!payable(pips, units)) this.flag('mana-colors', '601.2h', `${p.name} pays {${pips.map((x) => x.join('/')).join('}{')}} with ${units.map((u) => (u === 'any' ? '*' : u.join('/'))).join(',')}`);
  }

  // -------------------------------------------------------------------------
  // Decisions
  // -------------------------------------------------------------------------

  /** Look at a decision before anyone answers it. */
  before(d: Decision) {
    this.seen.decisions++;
    this.checkCasting();
    if (d.kind === 'priority') {
      this.checkState();
      this.checkCombat();
      this.checkOpening();
      this.checkActions(d.seat, d.actions);
    }
    if (d.kind === 'attackers') this.checkAttackCandidates(d.seat, d.candidates, d.defenders);
    if (!this.game.players[d.seat].alive) this.flag('dead-player-asked', '800.4a', `${this.game.players[d.seat].name} is asked to decide (${d.kind}) after leaving the game`);
  }

  /** Look at the answer given to a decision. */
  after(d: Decision, a: Answer) {
    const who = this.game.players[d.seat].name;
    switch (d.kind) {
      case 'priority': {
        const ans = a as { action: number; x?: number } | null;
        const i = ans?.action ?? 0;
        if (!Number.isInteger(i) || i < 0 || i >= d.actions.length) {
          this.flag('answer-range', '117.3', `${who} picks action ${i} of ${d.actions.length}`);
          break;
        }
        const act = d.actions[i];
        if (act.type === 'cast' && (ans?.x ?? 0) > act.maxX) this.flag('answer-x', '601.2b', `${who} picks X=${ans?.x} for ${act.card.name}, most they can pay is ${act.maxX}`);
        if (act.type === 'cast' && !act.free) {
          const p = this.game.players[d.seat];
          const command = act.from === 'command';
          const priced = act.kick ? this.game.kickedCard(act.card, act.kick) : act.mutate ? this.game.castCard(act.card, 'mutate') : act.card;
          this.casting = { seat: d.seat, card: act.card, priced, command, reduction: command ? (this.g.costReduction(p, act.card, true) as number) : 0, taxBefore: command ? 2 * (p.commanderCasts.get(act.card.name) ?? 0) : 0, paid: null, stack: this.game.stack.length };
          this.seen.casts++;
        }
        break;
      }
      case 'target': {
        const t = a as any;
        if (t === null) {
          if (!d.cancellable) this.flag('answer-target', '601.2c', `${who} gives no target for ${d.card.name}, which needs one`);
        } else if (!d.candidates.some((c) => JSON.stringify(c) === JSON.stringify(t))) {
          this.flag('answer-target', '601.2c', `${who} picks a target for ${d.card.name} that isn't one of the legal ones`);
        }
        break;
      }
      case 'choose': {
        const picks = Array.isArray(a) ? (a as number[]) : [];
        if (picks.length < d.min || picks.length > d.max) this.flag('answer-count', '700.2', `${who} picks ${picks.length} for "${d.prompt}" (needs ${d.min}-${d.max})`);
        if (new Set(picks).size !== picks.length || picks.some((i) => !Number.isInteger(i) || i < 0 || i >= d.options.length)) this.flag('answer-count', '700.2', `${who} picks invalid options for "${d.prompt}"`);
        break;
      }
      case 'attackers': {
        for (const decl of Array.isArray(a) ? (a as any[]) : []) {
          if (!d.candidates.includes(decl.attacker)) this.flag('answer-attack', '508.1a', `${who} declares an attacker that can't attack`);
          if (!d.defenders.includes(decl.defender)) this.flag('answer-attack', '508.1b', `${who} attacks a player who isn't an opponent in the game`);
        }
        break;
      }
      case 'blockers': {
        const used = new Set<number>();
        for (const decl of Array.isArray(a) ? (a as any[]) : []) {
          if (!d.candidates.includes(decl.blocker) || !d.attackers.includes(decl.attacker)) this.flag('answer-block', '509.1a', `${who} declares a block the engine didn't offer`);
          if (used.has(decl.blocker)) this.flag('answer-block', '509.1a', `${who} blocks with one creature twice`);
          used.add(decl.blocker);
        }
        break;
      }
      default:
        break;
    }
  }

  // -------------------------------------------------------------------------
  // What a player is offered when they have priority
  // -------------------------------------------------------------------------

  private checkActions(seat: number, actions: Action[]) {
    const g = this.game;
    const p = g.players[seat];
    const sorcery = g.activeSeat === seat && g.stack.length === 0 && (g.step === 'main1' || g.step === 'main2');
    if (actions[0]?.type !== 'pass') this.flag('no-pass', '117.3', `${p.name} can't pass priority`);
    for (const a of actions) {
      switch (a.type) {
        case 'land': {
          // 305.2: a land is played only with priority, in your main phase, with an empty stack, and one each turn.
          if (!sorcery) this.flag('land-timing', '305.2', `${p.name} may play ${a.card.name} in the ${g.step} step${g.stack.length ? ' with something on the stack' : ''}${g.activeSeat !== seat ? ' on someone else\'s turn' : ''}`);
          const extra = this.g.statics(p, 'extraLand') as number;
          if (p.landsPlayed >= 1 + extra) this.flag('land-count', '305.2', `${p.name} may play a land after already playing ${p.landsPlayed}`);
          const zone = a.fromGraveyard ? p.graveyard : a.from === 'exile' ? null : a.from === 'library' ? p.library.slice(0, 1) : p.hand;
          if (zone && !zone.includes(a.card)) this.flag('land-zone', '305.1', `${p.name} may play ${a.card.name}, which isn't where it is said to be`);
          break;
        }
        case 'cast': {
          const fromHandLike = a.from === 'hand' || a.from === 'command' || a.from === 'graveyard' || a.from === 'overload' || a.from === 'alt' || a.from === 'foretell' || a.from === 'warp' || a.from === 'exile' || a.from === 'library';
          // 307.1, 301.1 and friends: without flash, only at sorcery speed. Cards with their own timing say so in `casting.timing`.
          if (fromHandLike && !sorcery && !isInstantSpeed(a.card) && !a.card.casting?.timing && !g.hasFlashFor(p, a.card)) {
            this.flag('cast-timing', '307.1', `${p.name} may cast ${a.card.name} (${a.card.typeLine}) from ${a.from} in the ${g.step} step${g.stack.length ? ' with something on the stack' : ''}${g.activeSeat !== seat ? ' on someone else\'s turn' : ''}`);
          }
          if (a.from === 'plot' && !sorcery) this.flag('cast-timing', '702.170d', `${p.name} may cast plotted ${a.card.name} at instant speed`);
          if (a.from === 'command' && !p.commandZone.includes(a.card)) this.flag('cast-zone', '903.8', `${p.name} may cast ${a.card.name} from the command zone, but it isn't there`);
          if (a.from === 'hand' && !a.free && !p.hand.includes(a.card)) this.flag('cast-zone', '601.2', `${p.name} may cast ${a.card.name} from hand, but it isn't there`);
          if (a.card.isLand) this.flag('cast-land', '305.9', `${p.name} may cast the land ${a.card.name}`);
          break;
        }
        case 'activate': {
          const perm = g.findPerm(a.permId);
          if (!perm || perm.seat !== seat) {
            this.flag('activate-control', '602.2', `${p.name} may activate an ability of a permanent they don't control`);
            break;
          }
          const e = a.effect;
          if (e.when === 'loyalty') {
            if (!sorcery) this.flag('loyalty-timing', '606.3', `${p.name} may activate ${perm.card.name}'s loyalty ability at instant speed`);
            if (perm.loyaltyUsed) this.flag('loyalty-twice', '606.3', `${p.name} may activate a second loyalty ability of ${perm.card.name} this turn`);
            if ((e.loyalty ?? 0) < 0 && (perm.loyalty ?? 0) < -(e.loyalty ?? 0)) this.flag('loyalty-cost', '606.6', `${p.name} may pay ${-(e.loyalty ?? 0)} loyalty from ${perm.card.name}, which has ${perm.loyalty}`);
          } else if (e.kind === 'equip') {
            if (!sorcery) this.flag('equip-timing', '702.6a', `${p.name} may equip ${perm.card.name} at instant speed`);
          } else if (e.activation) {
            const act = e.activation;
            // 602.5a / 302.6: {T} abilities need an untapped permanent, and a creature that's been under your control since your turn began (or haste).
            if (act.tap && perm.tapped) this.flag('activate-tapped', '602.5a', `${p.name} may activate ${perm.card.name}'s {T} ability while it is tapped`);
            if (act.tap && perm.card.isCreature && perm.sick && !g.hasKw(perm, 'haste')) this.flag('summoning-sick', '302.6', `${p.name} may activate ${perm.card.name}'s {T} ability while it is summoning sick`);
            if (act.sorcery && !sorcery) this.flag('activate-timing', '602.5d', `${p.name} may activate ${perm.card.name}'s sorcery-speed ability now`);
            if (act.cost.life > 0 && act.cost.life >= p.life) this.flag('activate-life', '119.4', `${p.name} may pay ${act.cost.life} life with ${p.life} left`);
          }
          break;
        }
        case 'crew':
        case 'station':
        case 'unlock':
        case 'level': {
          if (!sorcery && a.type !== 'crew') this.flag(`${a.type}-timing`, '602.5d', `${p.name} may ${a.type} at instant speed`);
          const perm = g.findPerm(a.permId);
          if (!perm || perm.seat !== seat) this.flag('activate-control', '602.2', `${p.name} may ${a.type} a permanent they don't control`);
          break;
        }
        case 'ninjutsu': {
          const perm = g.findPerm(a.permId);
          if (g.step !== 'declareBlockers' && g.step !== 'combatDamage') this.flag('ninjutsu-timing', '702.49a', `${p.name} may use ninjutsu in the ${g.step} step`);
          if (!perm || perm.seat !== seat || perm.attacking === null || perm.blocked) this.flag('ninjutsu-target', '702.49a', `${p.name} may return a creature that isn't an unblocked attacker for ninjutsu`);
          break;
        }
        default:
          break;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Casting: commander tax (rule 903.8)
  // -------------------------------------------------------------------------

  private checkCasting() {
    const c = this.casting;
    if (!c) return;
    const g = this.game;
    // The spell, or a trigger it set off on top of it.
    const item: StackItem | undefined = g.stack.length > c.stack ? g.stack.slice(c.stack).find((s) => s.kind === 'spell' && s.card === c.card) ?? g.stack[g.stack.length - 1] : undefined;
    if (!item && c.paid === null) {
      // Not paid yet (choosing targets), or taken back.
      if (g.stack.length < c.stack || g.step === 'cleanup') this.casting = null;
      return;
    }
    this.casting = null;
    if (!item || item.card !== c.card || c.paid === null) return;
    const p = g.players[c.seat];
    if (c.command) {
      const after = 2 * (p.commanderCasts.get(c.card.name) ?? 0);
      if (after !== c.taxBefore + 2) this.flag('commander-tax-count', '903.8', `${p.name} cast ${c.card.name} from the command zone, but its tax went from ${c.taxBefore} to ${after}`);
      const spell = g.stack.find((s) => s.kind === 'spell' && s.card === c.card && s.controller === c.seat);
      const perm = spell ? null : p.battlefield.find((q) => q.card === c.card || q.front === c.card || q.parts?.some((x) => x.real === c.card));
      if ((spell && !spell.isCommander) || (perm && !perm.isCommander)) this.flag('commander-spell', '903.3', `${c.card.name} cast from the command zone isn't marked as a commander spell (on the stack: ${g.stack.map((s) => s.label).join(', ')})`);
      // Reductions as they were when the spell was cast ("the first spell each turn" no longer applies afterwards).
      const reduction = c.reduction;
      const owed = c.priced.cost.pips.length + c.priced.cost.generic + c.taxBefore - reduction;
      if (!c.card.freeWithCommander && item.kind === 'spell' && !item.alt && c.paid < owed) {
        this.flag('commander-tax', '903.8', `${p.name} paid ${c.paid} for ${c.card.name} from the command zone; it costs ${owed} with tax ${c.taxBefore} (paid with ${c.how})`);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Turns (rules 500, 103.8) and the opening hands (103.5)
  // -------------------------------------------------------------------------

  /** Called as `p`'s turn begins. */
  private checkTurn(p: PlayerState) {
    const g = this.game;
    this.seen.turns++;
    const prev = this.lastActive;
    if (prev >= 0) {
      // 101.4 / 500.7: turns pass to the next player still in the game; extra turns come in between.
      const expected = g.nextAliveSeat(prev);
      if (!g.inExtraTurn && !this.wasExtra && p.seat !== expected) {
        this.flag('turn-order', '101.4', `turn ${g.turnNumber + 1} goes to ${p.name}, but ${g.players[expected].name} is next`);
      }
    }
    this.lastActive = p.seat;
    this.wasExtra = g.inExtraTurn;
  }

  private checkOpening() {
    if (this.openingChecked) return;
    this.openingChecked = true;
    const g = this.game;
    const free = g.players.length > 2 ? 1 : 0;
    if (g.turnNumber !== 1) return;
    for (const p of g.players) {
      // 103.5 / 103.5c: seven cards, one fewer for each mulligan after the free one; the active player may already have drawn (multiplayer: no skipped draw, 103.8c).
      const expected = 7 - Math.max(0, p.mulligans - free) + (p.seat === g.activeSeat && g.step !== 'upkeep' && g.players.length > 2 ? 1 : 0);
      if (p.hand.length !== expected && p.hand.length + p.battlefield.filter((q) => !q.token).length + p.graveyard.length + p.exile.length !== expected) {
        this.flag('opening-hand', '103.5', `${p.name} has ${p.hand.length} cards at the start (expected ${expected} after ${p.mulligans} mulligans)`);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Combat as declared (rules 508, 509, 702)
  // -------------------------------------------------------------------------

  private checkCombat() {
    const g = this.game;
    const turn = g.turnNumber;
    const combat = g.combatsThisTurn;
    const attackers = g.attackers();
    if (g.step === 'declareAttackers' && attackers.length && !(this.attackCheckedTurn === turn && this.attackCheckedCombat === combat)) {
      this.attackCheckedTurn = turn;
      this.attackCheckedCombat = combat;
      for (const a of attackers) {
        this.seen.attacks++;
        const who = `${a.card.name} (${g.players[a.seat].name})`;
        if (!a.card.isCreature) this.flag('attack-noncreature', '508.1a', `${who} attacks but isn't a creature`);
        if (g.hasKw(a, 'defender') && !(g as unknown as AnyGame).usesToughness(a)) this.flag('attack-defender', '702.3b', `${who} has defender but attacks`);
        const d = a.attacking!;
        if (d === a.seat) this.flag('attack-self', '508.1b', `${who} attacks its own controller`);
        if (!g.players[d].alive) this.flag('attack-gone', '800.4a', `${who} attacks a player who left the game`);
        if (a.attackingPw !== undefined) {
          const pw = g.findPerm(a.attackingPw);
          if (pw && pw.card.isBattle) {
            // A battle is attacked through its protector, by anyone else (rules 506.2, 508.1b).
            if (pw.protector !== d) this.flag('attack-battle', '506.2', `${who} attacks ${pw.card.name}, but the defending player isn't its protector`);
            if (pw.protector === a.seat) this.flag('attack-battle', '508.1b', `${who} attacks ${pw.card.name}, which its controller protects`);
          } else if (pw && (!pw.card.isPlaneswalker || pw.seat !== d)) this.flag('attack-planeswalker', '508.1b', `${who} attacks ${pw.card.name}, which isn't a planeswalker controlled by the defending player`);
        }
        // Tokens put onto the battlefield attacking (myriad, Kiki-Jiki's copies) were never declared, so restrictions don't apply (rule 508.4).
        if (!a.token && !g.canAttack(a, d)) this.flag('attack-restricted', '508.1c', `${who} attacks ${g.players[d].name} despite a restriction`);
      }
    }
    if ((g.step === 'declareBlockers') && !(this.blockCheckedTurn === turn && this.blockCheckedCombat === combat)) {
      this.blockCheckedTurn = turn;
      this.blockCheckedCombat = combat;
      const blockers = new Map<number, Perm[]>();
      for (const q of g.players) for (const b of q.battlefield) {
        if (b.blocking === null) continue;
        this.seen.blocks++;
        const a = g.findPerm(b.blocking);
        const who = `${b.card.name} (${q.name})`;
        if (!a) continue;
        blockers.set(a.id, [...(blockers.get(a.id) ?? []), b]);
        if (!b.card.isCreature) this.flag('block-noncreature', '509.1a', `${who} blocks but isn't a creature`);
        if (a.attacking !== b.seat) this.flag('block-wrong-player', '509.1a', `${who} blocks ${a.card.name}, which isn't attacking ${q.name}`);
        this.checkBlock(a, b);
      }
      for (const [id, bs] of blockers) {
        const a = g.findPerm(id)!;
        if (g.hasKw(a, 'menace') && bs.length < 2) this.flag('block-menace', '702.111b', `${a.card.name} has menace but is blocked by ${bs[0].card.name} alone`);
      }
    }
  }

  /** 508.1a: who may be declared as an attacker, judged as attackers are declared (haste may be gone a moment later). */
  private checkAttackCandidates(seat: number, candidates: number[], defenders: number[]) {
    const g = this.game;
    for (const id of candidates) {
      const a = g.findPerm(id);
      if (!a) continue;
      const who = `${a.card.name} (${g.players[a.seat].name})`;
      if (a.seat !== seat) this.flag('attack-control', '508.1a', `${who} may attack for a player who doesn't control it`);
      if (!a.card.isCreature) this.flag('attack-noncreature', '508.1a', `${who} may attack but isn't a creature`);
      if (a.tapped) this.flag('attack-tapped', '508.1a', `${who} may attack while tapped`);
      if (a.sick && !g.hasKw(a, 'haste')) this.flag('attack-sick', '302.6', `${who} may attack the turn it came under its controller's control`);
      if (g.hasKw(a, 'defender') && !(g as unknown as AnyGame).usesToughness(a)) this.flag('attack-defender', '702.3b', `${who} has defender but may attack`);
    }
    for (const d of defenders) if (d === seat || !g.players[d].alive) this.flag('attack-defenders', '508.1b', `${g.players[seat].name} may attack ${g.players[d].name}`);
  }

  /** Evasion, checked from the rules rather than with the engine's own canBlock. */
  private checkBlock(a: Perm, b: Perm) {
    const g = this.game;
    const kw = (perm: Perm, k: string) => g.hasKw(perm, k);
    const who = `${b.card.name} blocks ${a.card.name}`;
    if (kw(a, 'flying') && !kw(b, 'flying') && !kw(b, 'reach')) this.flag('block-flying', '702.9b', `${who}, which has flying`);
    if (kw(a, 'unblockable')) this.flag('block-unblockable', '509.1b', `${who}, which can't be blocked`);
    if (kw(b, "can't block")) this.flag('block-cant', '509.1b', `${who}, but ${b.card.name} can't block`);
    if (kw(a, 'shadow') && !kw(b, 'shadow')) this.flag('block-shadow', '702.28b', `${who}, which has shadow`);
    if (kw(a, 'horsemanship') && !kw(b, 'horsemanship')) this.flag('block-horsemanship', '702.31b', `${who}, which has horsemanship`);
    const colorsOf = (perm: Perm) => new Set<string>(cardColors(perm.card));
    if (kw(a, 'intimidate') && !b.card.isArtifact && ![...colorsOf(a)].some((c) => colorsOf(b).has(c))) this.flag('block-intimidate', '702.13b', `${who}, which has intimidate`);
    if (kw(a, 'fear') && !b.card.isArtifact && !colorsOf(b).has('B')) this.flag('block-fear', '702.36b', `${who}, which has fear`);
    if (kw(a, 'skulk') && g.power(b) > g.power(a)) this.flag('block-skulk', '702.118b', `${who}, which has skulk`);
    for (const c of colorsOf(b)) {
      const name = ({ W: 'white', U: 'blue', B: 'black', R: 'red', G: 'green' } as Record<string, string>)[c];
      if (kw(a, `protection from ${name}`) || kw(a, 'protection from all colors') || kw(a, 'protection from everything')) this.flag('block-protection', '702.16e', `${who}, which has protection from ${name}`);
    }
    if (kw(a, 'protection from creatures')) this.flag('block-protection', '702.16e', `${who}, which has protection from creatures`);
    const lands = this.game.players[b.seat].battlefield.filter((q) => q.card.isLand);
    for (const type of ['Plains', 'Island', 'Swamp', 'Mountain', 'Forest']) {
      if (kw(a, `${type.toLowerCase()}walk`) && lands.some((l) => l.card.typeLine.includes(type))) this.flag('block-landwalk', '702.14c', `${who}, which has ${type.toLowerCase()}walk`);
    }
  }

  // -------------------------------------------------------------------------
  // The game state whenever a player gets priority (rules 704, 800.4a, 903)
  // -------------------------------------------------------------------------

  checkState() {
    const g = this.game;
    if (g.over) return;
    for (const p of g.players) {
      if (!p.alive) {
        // 800.4a: a player who leaves takes everything they own with them, and stops controlling anything.
        if (p.battlefield.length) this.flag('left-permanents', '800.4a', `${p.name} left the game but still controls ${p.battlefield.length} permanents`);
        for (const q of g.players) for (const perm of q.battlefield) if (perm.owner === p.seat && !perm.token) this.flag('left-owned', '800.4a', `${perm.card.name}, owned by ${p.name} who left, is still on the battlefield`);
        if (g.stack.some((s) => s.controller === p.seat)) this.flag('left-stack', '800.4a', `${p.name} left the game but controls something on the stack`);
        continue;
      }
      // 704.5a-c, 903.10a: these players should already have lost.
      const shield = g.lossShield(p);
      if (p.life <= 0 && !shield) this.flag('sba-life', '704.5a', `${p.name} is still in the game at ${p.life} life`);
      if (p.poison >= 10 && shield !== 'all') this.flag('sba-poison', '704.5c', `${p.name} is still in the game with ${p.poison} poison counters`);
      for (const [key, dmg] of p.commanderDamage) if (dmg >= COMMANDER_DAMAGE && shield !== 'all') this.flag('commander-damage', '903.10a', `${p.name} has taken ${dmg} damage from ${key} and is still in the game`);
      if (p.treasures < 0 || p.energy < 0 || (p.pool ?? []).some((m) => m.n < 0)) this.flag('negative-resource', '106.4', `${p.name} has negative treasures, energy or mana`);
      // 704.5j: the legend rule, per controller.
      const names = new Map<string, number>();
      for (const perm of p.battlefield) if (perm.card.isLegendary && !perm.emblem) names.set(perm.card.name, (names.get(perm.card.name) ?? 0) + 1);
      for (const [name, n] of names) if (n > 1) this.flag('sba-legend', '704.5j', `${p.name} controls ${n} legendary permanents named ${name}`);
      for (const perm of p.battlefield) {
        if (perm.seat !== p.seat) this.flag('perm-seat', '108.4', `${perm.card.name} sits with ${p.name} but says its controller is seat ${perm.seat}`);
        if (perm.card.isCreature && !perm.emblem) {
          const t = g.toughness(perm);
          // 704.5f-h: toughness 0, lethal damage, deathtouch damage.
          if (t <= 0) this.flag('sba-toughness', '704.5f', `${perm.card.name} (${p.name}) is still on the battlefield with toughness ${t}`);
          else if (perm.damage >= t && !g.hasKw(perm, 'indestructible') && !(g as unknown as AnyGame).regenerated?.(perm)) this.flag('sba-damage', '704.5g', `${perm.card.name} (${p.name}) has ${perm.damage} damage and toughness ${t}`);
        }
        if (perm.loyalty !== undefined && perm.loyalty <= 0 && perm.card.isPlaneswalker) this.flag('sba-loyalty', '704.5i', `${perm.card.name} (${p.name}) has no loyalty left`);
        if (perm.card.isBattle) {
          if ((perm.defense ?? 0) <= 0) this.flag('sba-defense', '704.5v', `${perm.card.name} (${p.name}) has no defense left`);
          if (perm.protector === undefined || perm.protector === p.seat || !g.players[perm.protector].alive) this.flag('sba-protector', '704.5w', `${perm.card.name} (${p.name}) has no protector`);
        }
      }
    }
    for (const s of g.stack) if (!g.players[s.controller].alive) this.flag('left-stack', '800.4a', `${s.label} on the stack is controlled by a player who left`);
    this.checkCards();
  }

  /** Every card a player owns is somewhere, once (and each commander exactly once). Tokens and copies aren't cards. */
  private checkCards() {
    const g = this.game;
    const counts = g.players.map(() => 0);
    const commanderSeen = new Map<string, number>();
    const names = g.players.map(() => new Map<SimCard, number>());
    const add = (owner: number, card: SimCard | null | undefined, n = 1) => {
      if (!card) return;
      counts[owner] += n;
      names[owner].set(card, (names[owner].get(card) ?? 0) + n);
      if (g.players[owner].deck.commanders.includes(card)) commanderSeen.set(`${g.players[owner].name}: ${card.name}`, (commanderSeen.get(`${g.players[owner].name}: ${card.name}`) ?? 0) + n);
    };
    for (const p of g.players) {
      for (const c of [...p.library, ...p.hand, ...p.graveyard, ...p.exile, ...p.commandZone]) add(p.seat, c);
      for (const h of p.held ?? []) add(p.seat, h.card);
    }
    for (const q of g.players) for (const perm of q.battlefield) {
      if (perm.emblem) continue;
      const owner = perm.owner ?? perm.seat;
      if (perm.parts) {
        for (const part of perm.parts) add(owner, part.real);
      } else if (!perm.token) {
        add(owner, perm.faceDown ?? perm.front ?? perm.printed ?? perm.unlocked ?? perm.uncrewed ?? perm.impendingCard ?? perm.card);
      }
      if (perm.hidden) add(owner, perm.hidden);
    }
    for (const s of g.stack) if (s.kind === 'spell' && !s.copy) add(s.owner ?? s.controller, s.faceDown ?? s.card);
    for (const p of g.players) {
      if (!p.alive) continue;
      // Some cards sit in places this check can't see (exiled "with" a permanent, set aside to be cast); so only a surplus is a sure error.
      if (counts[p.seat] > this.cardCounts[p.seat]) {
        const extra = [...names[p.seat]].filter(([card, n]) => n > (p.deck.cards.find((e) => e.card === card)?.count ?? (p.deck.commanders.includes(card) ? 1 : 0))).map(([card, n]) => `${card.name} x${n}`);
        this.flag('card-duplicated', '400.1', `${p.name} owns ${counts[p.seat]} cards in the game but their deck has ${this.cardCounts[p.seat]} (${extra.join(', ') || 'a card from outside the deck'})`);
      }
    }
    for (const [name, n] of commanderSeen) if (n > 1) {
      const card = name.slice(name.indexOf(': ') + 2);
      const where: string[] = [];
      for (const p of g.players) for (const [zone, cards] of Object.entries({ library: p.library, hand: p.hand, graveyard: p.graveyard, exile: p.exile, command: p.commandZone })) if (cards.some((c) => c.name === card)) where.push(`${p.name} ${zone}`);
      for (const q of g.allPerms()) if (q.card.name === card || q.front?.name === card || q.unlocked?.name === card) where.push(`battlefield (${g.players[q.seat].name})`);
      for (const s of g.stack) if (s.card.name === card) where.push('stack');
      this.flag('commander-duplicated', '903.3', `${name} is in ${n} places at once: ${where.join(', ')}`);
    }
  }
}

/** Can these units of mana pay these colored pips? (Generic mana is checked by count.) */
function payable(pips: string[][], units: (string[] | 'any')[]): boolean {
  // Bipartite matching, pips to units; small enough for a simple augmenting search.
  const match = new Array<number>(units.length).fill(-1);
  const fits = (pip: string[], u: string[] | 'any') => u === 'any' || pip.some((m) => u.includes(m));
  const tryPip = (i: number, seen: boolean[]): boolean => {
    for (let j = 0; j < units.length; j++) {
      if (seen[j] || !fits(pips[i], units[j])) continue;
      seen[j] = true;
      if (match[j] === -1 || tryPip(match[j], seen)) {
        match[j] = i;
        return true;
      }
    }
    return false;
  };
  for (let i = 0; i < pips.length; i++) if (!tryPip(i, new Array(units.length).fill(false))) return false;
  return true;
}

/** Play one bot game with the referee watching. */
export function refereeGame(decks: SimDeck[], seed: number, opts: GameOptions = {}): { referee: Referee; game: Game; decisions: number } {
  const game = new Game(decks, seed, opts);
  const referee = new Referee(game, seed);
  const bots = decks.map((_, seat) => new Bot(seat, seed));
  const flow = game.run();
  let next = flow.next();
  let decisions = 0;
  while (!next.done) {
    const d = next.value;
    referee.before(d);
    const a = bots[d.seat].decide(game, d);
    referee.after(d, a);
    next = flow.next(a);
    if (++decisions > 400_000) throw new Error(`seed ${seed}: too many decisions`);
  }
  return { referee, game, decisions };
}
