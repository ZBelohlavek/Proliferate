// Proliferate's own Magic AI: a heuristic player that answers every decision
// the rules engine asks for: mulligans, land drops, what to cast and when,
// targets, attacks, blocks and responses on the stack.
//
// It reads the same public game state a person at the table would, plus its
// own hand. It never looks at other players' hands or at any library.

import { Rng } from '../engine/rng';
import type { Effect, Mana, SimCard } from '../engine/types';
import { counterMatches, isAura, isInstantSpeed, recursionMatches, removalMatches, type Game } from './game';
import type {
  Action, Agent, Answer, AttackDeclaration, BlockDeclaration, Decision, Perm, PlayerState, PriorityAnswer, StackItem, Target,
} from './types';

const ALL_COLORS: Mana[] = ['W', 'U', 'B', 'R', 'G'];
const REACTIVE_KINDS = new Set(['counter', 'pump', 'protect']);

export interface BotOptions {
  /** How eagerly it attacks: about 0.6 (careful) to 1.5 (reckless). Default: random 0.8–1.3. */
  aggression?: number;
}

type Removal = Extract<Effect, { kind: 'removal' }>;
type Wipe = Extract<Effect, { kind: 'wipe' }>;
type Pump = Extract<Effect, { kind: 'pump' }>;
type CastAction = Extract<Action, { type: 'cast' }>;

// ---------------------------------------------------------------------------
// Board evaluation, shared with the table UI's hints
// ---------------------------------------------------------------------------

/** How dangerous a permanent is to its opponents. */
export function threat(g: Game, perm: Perm): number {
  const card = perm.card;
  let t = 0;
  if (card.isCreature) {
    const power = g.power(perm);
    const evasive = g.hasKw(perm, 'flying') || g.hasKw(perm, 'unblockable') || g.hasKw(perm, 'menace');
    t += power * (evasive ? 1.5 : 1) + g.toughness(perm) * 0.2;
    if (g.hasKw(perm, 'double strike')) t += power;
  }
  for (const e of card.effects) {
    if (e.when === 'resolve') continue;
    switch (e.kind) {
      case 'anthem': t += 3 * (e.p + e.t); break;
      case 'mana': t += 1.5 * e.amount; break;
      case 'costReduction': t += 2 * e.amount; break;
      case 'equip': t += e.p + e.t + e.keywords.length; break;
      default: t += 3;
    }
  }
  if (perm.isCommander) t += 4;
  if (perm.token) t *= 0.7;
  return t;
}

/** Board strength of a player. */
export function boardThreat(g: Game, p: PlayerState, creaturesOnly = false): number {
  let t = 0;
  for (const perm of p.battlefield) {
    if (perm.landInfo) continue;
    if (creaturesOnly && !perm.card.isCreature) continue;
    t += threat(g, perm);
  }
  return t;
}

/** Damage `a` deals in one combat (double strike counts twice). */
function hitDamage(g: Game, a: Perm): number {
  return g.power(a) * (g.hasKw(a, 'double strike') ? 2 : 1);
}

function kills(g: Game, attacker: Perm, defender: Perm): boolean {
  return g.hasKw(attacker, 'deathtouch') ? g.power(attacker) > 0 : hitDamage(g, attacker) >= g.toughness(defender) - defender.damage;
}

function survives(g: Game, creature: Perm, from: Perm): boolean {
  if (g.hasKw(creature, 'indestructible')) return true;
  if (g.hasKw(creature, 'first strike') && !g.hasKw(from, 'first strike') && !g.hasKw(from, 'double strike') && kills(g, creature, from)) return true;
  return !kills(g, from, creature);
}

// ---------------------------------------------------------------------------
// The bot
// ---------------------------------------------------------------------------

export class Bot implements Agent {
  private readonly rng: Rng;
  readonly aggression: number;
  /** Spells on the stack this bot already decided whether to answer. */
  private readonly considered = new Set<number>();
  /** X of the spell this bot is in the middle of casting, for choosing its targets. */
  private castingX = 0;

  constructor(readonly seat: number, seed: number, opts: BotOptions = {}) {
    this.rng = new Rng((seed ^ ((seat + 1) * 0x9e3779b1)) >>> 0);
    this.aggression = opts.aggression ?? 0.8 + this.rng.next() * 0.5;
  }

  decide(g: Game, d: Decision): Answer {
    const p = g.players[d.seat];
    switch (d.kind) {
      case 'priority': return this.priority(g, p, d.actions);
      case 'target': return this.target(g, p, d);
      case 'attackers': return this.attack(g, p, d.candidates, d.defenders);
      case 'blockers': return this.block(g, p, d.attackers, d.candidates);
      case 'choose': return this.choose(g, p, d);
      case 'confirm':
        if (d.reason === 'mulligan') return !this.keepable(p.hand, p.mulligans);
        // A commander that was bounced is cheaper to recast from hand (no tax); otherwise take it back.
        return d.to !== 'hand';
    }
  }

  // -------------------------------------------------------------------------
  // Mulligans
  // -------------------------------------------------------------------------

  private keepable(hand: SimCard[], mulligans: number): boolean {
    if (mulligans >= 3) return true;
    let lands = 0;
    let cheapRamp = 0;
    for (const c of hand) {
      if (c.isLand || c.backLand) lands++;
      else if (c.cmc <= 3 && c.effects.some((e) => e.kind === 'mana' || e.kind === 'ramp')) cheapRamp++;
    }
    return lands + cheapRamp * 0.5 >= 2.5 && lands >= 2 && lands <= 5;
  }

  private cardScore(g: Game, p: PlayerState, c: SimCard, landsInHand: number): number {
    const lands = g.landCount(p) + landsInHand;
    // Extra lands are worth little once we have plenty.
    return c.isLand ? (lands > 6 ? 0.5 : 6) : c.value - c.cmc * 0.2;
  }

  // -------------------------------------------------------------------------
  // Priority: what to do right now
  // -------------------------------------------------------------------------

  private priority(g: Game, p: PlayerState, actions: Action[]): PriorityAnswer {
    const pick = (a: Action | undefined, x = 0): PriorityAnswer => {
      this.castingX = x;
      return { action: a ? Math.max(0, actions.indexOf(a)) : 0, x };
    };
    const casts = actions.filter((a): a is CastAction => a.type === 'cast');
    const top = g.stack[g.stack.length - 1];

    // Something is on the stack: answer it or let it resolve.
    if (top) {
      if (top.controller === p.seat || this.considered.has(top.id)) return pick(undefined);
      this.considered.add(top.id);
      return pick(this.response(g, p, top, casts));
    }

    const myTurn = g.activeSeat === p.seat;
    if (myTurn && (g.step === 'main1' || g.step === 'main2')) {
      const land = this.chooseLand(g, p, actions);
      if (land) return pick(land);
      const equip = this.chooseEquip(g, actions);
      if (equip) return pick(equip);
      const spell = this.chooseSpell(g, p, casts, false);
      if (spell) return pick(spell.action, spell.x);
      if (g.step === 'main2') return pick(this.chooseAbility(g, p, actions));
      return pick(undefined);
    }

    // Combat tricks once blockers are known.
    if (g.step === 'declareBlockers') return pick(this.chooseTrick(g, p, casts));

    // The end step before our own turn: use instants and abilities with mana that would otherwise be wasted.
    if (!myTurn && g.step === 'end' && g.nextAliveSeat(g.activeSeat) === p.seat) {
      const spell = this.chooseSpell(g, p, casts, true);
      if (spell) return pick(spell.action, spell.x);
      return pick(this.chooseAbility(g, p, actions));
    }
    return pick(undefined);
  }

  /** Counter an opponent's spell, or protect a permanent it targets. */
  private response(g: Game, p: PlayerState, top: StackItem, casts: CastAction[]): Action | undefined {
    if (top.kind === 'spell') {
      const counter = casts.find((a) => a.card.effects.some((e) => e.kind === 'counter' && counterMatches(e.target, top.card)));
      if (counter && this.wantsToCounter(g, p, top)) return counter;
    }
    // A board wipe that would cost us a real board: protect all of it if we can.
    if (top.controller !== p.seat && top.effects.some((e) => e.kind === 'wipe') && boardThreat(g, p, true) > 6) {
      const shield = casts.find((a) => isInstantSpeed(a.card) && a.card.effects.some((f) => f.kind === 'protect' && f.all));
      if (shield) return shield;
    }
    // Is one of our better permanents about to be removed?
    for (let i = 0; i < top.effects.length; i++) {
      const e = top.effects[i];
      const t = top.targets[i];
      if (e.kind !== 'removal' || !t || t.kind !== 'perm') continue;
      const perm = g.findPerm(t.id);
      if (!perm || perm.seat !== p.seat || threat(g, perm) < 5) continue;
      const save = casts.find((a) => isInstantSpeed(a.card) && a.card.effects.some((f) => f.kind === 'protect' || (f.kind === 'pump' && f.protect)));
      if (save) return save;
    }
    return undefined;
  }

  private wantsToCounter(g: Game, p: PlayerState, top: StackItem): boolean {
    const caster = g.players[top.controller];
    const wipe = top.effects.find((e): e is Extract<Effect, { kind: 'wipe' }> => e.kind === 'wipe');
    if (wipe) {
      const hurtsMe = boardThreat(g, p, wipe.target === 'creatures');
      const hurtsThem = boardThreat(g, caster, wipe.target === 'creatures');
      return hurtsMe > 6 && (wipe.oneSided || hurtsMe > hurtsThem);
    }
    // Removal aimed at our best permanents is worth stopping.
    for (let i = 0; i < top.effects.length; i++) {
      const t = top.targets[i];
      const perm = t?.kind === 'perm' ? g.findPerm(t.id) : null;
      if (top.effects[i].kind === 'removal' && perm?.seat === p.seat && threat(g, perm) >= 7) return true;
    }
    if (top.isCommander || top.card.value >= 9) return this.rng.chance(0.6);
    if (top.card.value >= 6) return this.rng.chance(0.25);
    return false;
  }

  private chooseLand(g: Game, p: PlayerState, actions: Action[]): Action | undefined {
    const options = actions.filter((a): a is Extract<Action, { type: 'land' }> => a.type === 'land');
    if (!options.length) return undefined;
    const available = g.availableMana(p);
    const spells = p.hand.filter((c) => !c.isLand);
    const maxCost = Math.max(0, ...spells.map((c) => g.effectiveCost(p, c)));
    const have = g.colorsAvailable(p);
    const needed = new Set<Mana>();
    for (const c of [...p.hand, ...p.commandZone]) for (const pip of c.cost.pips) if (!pip.some((m) => have.has(m))) pip.forEach((m) => needed.add(m));

    let best = options[0];
    let bestScore = -Infinity;
    for (const o of options) {
      const info = o.back ? o.card.backLand! : o.card.land!;
      let score = 0;
      if (o.back) score -= g.landCount(p) >= 4 ? 8 : 3; // rather cast the spell side later
      if (!info.tapped) score += 2;
      // If the extra mana can't be used this turn anyway, get tapped lands out of the way.
      else if (maxCost <= available) score += 3;
      for (const m of info.produces === 'any' ? ALL_COLORS : info.produces) if (needed.has(m)) score += 3;
      if (info.produces === 'any') score += 1;
      if (score > bestScore) {
        best = o;
        bestScore = score;
      }
    }
    if (best.back && g.landCount(p) >= 5) return undefined;
    return best;
  }

  /** Equip loose Equipment before combat. */
  private chooseEquip(g: Game, actions: Action[]): Action | undefined {
    if (g.step !== 'main1') return undefined;
    return actions.find((a) => {
      if (a.type !== 'activate' || a.effect.kind !== 'equip') return false;
      const perm = g.findPerm(a.permId);
      return !!perm && perm.attachedTo === null && perm.activations === 0;
    });
  }

  private chooseSpell(g: Game, p: PlayerState, casts: CastAction[], instantWindow: boolean): { action: CastAction; x: number } | undefined {
    if (!casts.length) return undefined;
    const available = g.availableMana(p);
    const reserve = instantWindow ? 0 : this.reservedMana(g, p);
    let best: { action: CastAction; x: number } | undefined;
    let bestScore = -Infinity;
    for (const a of casts) {
      const card = a.card;
      const fromCommand = a.from === 'command';
      let x = a.maxX;
      if (card.xFromLife) {
        // Pay only as much life as the biggest opposing creature needs, and never go low.
        const need = Math.max(0, ...g.opponents(p).flatMap((o) => o.battlefield.filter((q) => q.card.isCreature).map((q) => g.toughness(q))));
        x = Math.min(x, need);
        if (x <= 0 || p.life - x < 10) continue;
      }
      if (card.cost.x > 0 && x < (card.isCreature ? 2 : 3)) continue;
      let score = this.castScore(g, p, card, fromCommand, x, instantWindow);
      if (score === null) continue;
      // Keep mana up for counterspells and protection unless this play matters.
      if (reserve > 0 && score < 90 && available - g.effectiveCost(p, card, fromCommand, x) < reserve) continue;
      score += card.cmc * 0.1;
      if (score > bestScore) {
        best = { action: a, x };
        bestScore = score;
      }
    }
    return best;
  }

  private reservedMana(g: Game, p: PlayerState): number {
    if (g.round < 3) return 0;
    let reserve = 0;
    for (const c of p.hand) {
      if (c.effects.some((e) => e.kind === 'counter' || e.kind === 'protect')) {
        const cost = g.effectiveCost(p, c);
        if (reserve === 0 || cost < reserve) reserve = cost;
      }
    }
    return reserve;
  }

  /** How much the bot wants to cast this now. null = don't. */
  private castScore(g: Game, p: PlayerState, card: SimCard, fromCommand: boolean, x: number, instantWindow: boolean): number | null {
    const kinds = new Set(card.effects.filter((e) => e.when === 'resolve' || e.when === 'static').map((e) => e.kind));
    if (fromCommand) return 85 + card.value;

    // Purely reactive spells wait for something to react to.
    if (!card.isCreature && card.effects.length > 0 && card.effects.every((e) => REACTIVE_KINDS.has(e.kind))) return null;
    if (kinds.has('overrun')) return g.step === 'main1' && this.readyAttackers(g, p).length >= 3 ? 60 : null;

    if (kinds.has('wipe')) {
      const wipe = card.effects.find((e): e is Wipe => e.kind === 'wipe')!;
      return this.wipeIsGood(g, p, wipe, x) ? 95 : null;
    }

    let score = 0;
    if (kinds.has('mana') || kinds.has('ramp') || kinds.has('costReduction') || kinds.has('treasure') || kinds.has('extraLand')) {
      score = Math.max(score, 100 - g.round * 4);
    }
    const spell = card.isInstant || card.isSorcery;
    const removal = card.effects.find((e): e is Removal => e.kind === 'removal' && e.when === 'resolve');
    if (removal) {
      const target = this.removalTarget(g, p, removal, x, g.targetCandidates(p, removal, null) ?? []);
      if (target && target.score >= 3 + g.round * 0.2) score = Math.max(score, 70 + target.score);
      else if (spell) return null;
    }
    if (spell && card.effects.some((e) => e.kind === 'damagePlayer' && e.when === 'resolve') && !removal) score = Math.max(score, 30);
    const regrow = card.effects.find((e): e is Extract<Effect, { kind: 'recursion' }> => e.kind === 'recursion' && e.when === 'resolve');
    if (regrow && !p.graveyard.some((c) => recursionMatches(regrow.what, c)) && !card.isCreature) return null;
    const stealAura = card.effects.some((e) => e.kind === 'equip' && e.steal);
    if (stealAura) return g.opponents(p).some((o) => o.battlefield.some((q) => q.card.isCreature && g.canTarget(p, q) && threat(g, q) >= 4)) ? 75 : null;
    if (isAura(card) && !p.battlefield.some((q) => q.card.isCreature)) return null;
    if (kinds.has('cheat') && spell && !p.hand.some((c) => c.isCreature)) return null;
    if (kinds.has('exileGraveyards') && spell && kinds.size === 1) return g.opponents(p).some((o) => o.graveyard.length >= 6) ? 15 : null;
    if (kinds.has('extraTurn') || kinds.has('approach') || kinds.has('steal') || kinds.has('cheat')) score = Math.max(score, 55 + card.value);
    if (spell && kinds.has('counters') && !p.battlefield.some((q) => q.card.isCreature)) return null;

    if (!spell) score = Math.max(score, 50 + card.value);
    if (kinds.has('draw')) score = Math.max(score, 45 + card.value);
    if (kinds.has('mill') || kinds.has('discard') || kinds.has('scry')) score = Math.max(score, 25 + card.value);
    if (kinds.has('tutor') || kinds.has('recursion') || kinds.has('tokens') || kinds.has('drain') || kinds.has('damagePlayer') || kinds.has('counters')) {
      score = Math.max(score, 40 + card.value);
    }
    if (kinds.has('gainLife')) score = Math.max(score, 10);
    if (!card.modeled) {
      if (spell) return null;
      score = Math.max(score, 1);
    }
    // Instants in our own main phase: only if nothing better. They usually wait for the end-of-turn window.
    if (card.isInstant && !instantWindow && !card.effects.some((e) => e.kind === 'ramp')) score = Math.min(score, 20);
    return score || null;
  }

  private chooseAbility(g: Game, p: PlayerState, actions: Action[]): Action | undefined {
    // Planeswalkers: a minus ability worth using now, otherwise the biggest plus.
    const loyal = actions.filter((a): a is Extract<Action, { type: 'activate' }> => a.type === 'activate' && a.effect.when === 'loyalty');
    if (loyal.length) {
      const worth = (a: Extract<Action, { type: 'activate' }>) => {
        const e = a.effect;
        if (e.kind === 'removal') {
          const t = this.removalTarget(g, p, e, 0, g.targetCandidates(p, e, g.findPerm(a.permId)) ?? []);
          return !!t && t.score >= 4;
        }
        if (e.kind === 'wipe') return this.wipeIsGood(g, p, e, 0);
        if (e.kind === 'recursion') return p.graveyard.some((c) => recursionMatches(e.what, c));
        return e.kind !== 'gainLife' && e.kind !== 'scry';
      };
      const minus = loyal.filter((a) => (a.effect.loyalty ?? 0) < 0 && worth(a)).sort((x, y) => (x.effect.loyalty ?? 0) - (y.effect.loyalty ?? 0))[0];
      const plus = loyal.filter((a) => (a.effect.loyalty ?? 0) >= 0).sort((x, y) => (y.effect.loyalty ?? 0) - (x.effect.loyalty ?? 0))[0];
      const perm = minus ? g.findPerm(minus.permId) : null;
      // Keep at least one loyalty unless the ability is removal that matters.
      if (minus && perm && ((perm.loyalty ?? 0) + (minus.effect.loyalty ?? 0) >= 1 || minus.effect.kind === 'removal' || minus.effect.kind === 'wipe')) return minus;
      if (plus) return plus;
    }
    return actions.find((a) => {
      if (a.type !== 'activate' || a.effect.kind === 'equip') return false;
      const perm = g.findPerm(a.permId);
      if (!perm || (!a.effect.activation?.tap && perm.activations >= 3)) return false;
      const e = a.effect;
      // Paying life: only while comfortably healthy.
      if ((e.activation?.cost.life ?? 0) > 0 && p.life < 20) return false;
      if (e.activation?.sacCreature) {
        // Sacrifice outlets: only feed them tokens and small creatures, and only for something worth having.
        if (e.kind === 'treasure') return false;
        const fodder = p.battlefield.filter((q) => q.card.isCreature && q !== perm && !q.isCommander && (q.token || q.card.value < 2.5));
        if (!fodder.length || perm.activations >= 2) return false;
      }
      switch (e.kind) {
        case 'draw': return p.library.length > 8;
        case 'tokens': case 'counters': case 'drain': case 'damagePlayer': case 'ramp': case 'tutor': case 'treasure': case 'discard': case 'scry': return true;
        case 'mill': return e.who !== 'you';
        // "Can't be blocked this turn": before combat, with something worth sending in.
        case 'pump': return !!e.grant?.includes('unblockable') && g.step === 'main1' && g.activeSeat === p.seat && p.battlefield.some((q) => q.card.isCreature && !q.tapped && !q.sick && g.power(q) >= 3);
        case 'removal': {
          const t = this.removalTarget(g, p, e, 0, g.targetCandidates(p, e, perm) ?? []);
          return !!t && t.score >= 3 + g.round * 0.2;
        }
        case 'recursion': return !e.toTop && p.graveyard.some((c) => recursionMatches(e.what, c));
        case 'exileGraveyards': return g.opponents(p).some((o) => o.graveyard.length >= 8);
        case 'cheat': return p.hand.some((c) => c.isCreature);
        default: return false;
      }
    });
  }

  /** Pump a creature to win a fight, save an attacker, or finish a player. */
  private chooseTrick(g: Game, p: PlayerState, casts: CastAction[]): Action | undefined {
    const trick = casts.find((a) => a.card.effects.some((e) => e.kind === 'pump'));
    return trick && this.trickTarget(g, p, trick.card) ? trick : undefined;
  }

  private trickTarget(g: Game, p: PlayerState, card: SimCard): Perm | null {
    const pump = card.effects.find((e): e is Pump => e.kind === 'pump');
    if (!pump) return null;
    const bonus = pump.p === -1 ? 3 : pump.p;
    const bonusT = pump.t === -1 ? 3 : pump.t;
    for (const mine of p.battlefield) {
      if (!mine.card.isCreature || !g.canTarget(p, mine)) continue;
      if (mine.attacking !== null) {
        const blockers = g.blockersOf(mine);
        if (mine.blocked && blockers.length) {
          const dies = blockers.reduce((s, b) => s + g.power(b), 0) >= g.toughness(mine) - mine.damage && !g.hasKw(mine, 'indestructible');
          const savedBy = blockers.reduce((s, b) => s + g.power(b), 0) < g.toughness(mine) + bonusT - mine.damage || pump.protect;
          const killsNow = blockers.every((b) => kills(g, mine, b));
          const killsPumped = blockers.length === 1 && g.power(mine) + bonus >= g.toughness(blockers[0]) - blockers[0].damage;
          if ((dies && savedBy && threat(g, mine) >= 4) || (!killsNow && killsPumped)) return mine;
        } else if (!mine.blocked) {
          // Unblocked: pump for lethal.
          const d = g.players[mine.attacking];
          const incoming = g.attackers().filter((a) => a.attacking === d.seat && !a.blocked).reduce((s, a) => s + hitDamage(g, a), 0);
          if (d.alive && incoming < d.life && incoming + bonus * (g.hasKw(mine, 'double strike') ? 2 : 1) >= d.life) return mine;
        }
      } else if (mine.blocking !== null) {
        const a = g.findPerm(mine.blocking);
        if (!a) continue;
        const dies = !survives(g, mine, a);
        const savedBy = g.power(a) < g.toughness(mine) + bonusT - mine.damage || pump.protect;
        if (dies && savedBy && !g.hasKw(a, 'deathtouch') && threat(g, mine) >= 4) return mine;
        if (!kills(g, mine, a) && g.power(mine) + bonus >= g.toughness(a) - a.damage && threat(g, a) >= 4) return mine;
      }
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // Targets
  // -------------------------------------------------------------------------

  private target(g: Game, p: PlayerState, d: Extract<Decision, { kind: 'target' }>): Target | null {
    const e = d.effect;
    const perms = d.candidates.flatMap((t) => (t.kind === 'perm' ? [g.findPerm(t.id)] : [])).filter((q): q is Perm => q !== null);
    const mine = perms.filter((q) => q.seat === p.seat);
    const asTarget = (perm: Perm | null | undefined): Target | null => (perm ? { kind: 'perm', id: perm.id } : null);
    const bestOf = (list: Perm[], score: (q: Perm) => number) => (list.length ? list.reduce((a, b) => (score(b) > score(a) ? b : a)) : null);

    // Aura spells and Equipment: our best creature.
    if (e === null && d.card.effects.some((f) => f.kind === 'equip' && f.steal)) {
      const theirs = perms.filter((q) => q.seat !== p.seat);
      return asTarget(bestOf(theirs.length ? theirs : perms, (q) => threat(g, q))) ?? d.candidates[0];
    }
    if (e === null || e.kind === 'equip') {
      const pool = mine.length ? mine : perms;
      return asTarget(bestOf(pool, (q) => g.power(q) + (q.isCommander ? 2 : 0) - (q.sick ? 1 : 0))) ?? d.candidates[0];
    }
    switch (e.kind) {
      case 'removal': {
        const pick = this.removalTarget(g, p, e, this.castingX, d.candidates);
        if (pick) return pick.target;
        // Forced to choose (a trigger): the least valuable legal target.
        return asTarget(bestOf(perms, (q) => (q.seat === p.seat ? -threat(g, q) : 0))) ?? d.candidates[0];
      }
      case 'counter': {
        const spells = d.candidates.flatMap((t) => (t.kind === 'stack' ? g.stack.filter((s) => s.id === t.id) : []));
        const theirs = spells.filter((s) => s.controller !== p.seat);
        const pool = theirs.length ? theirs : spells;
        const top = pool.reduce((a, b) => (b.card.value > a.card.value ? b : a), pool[0]);
        return top ? { kind: 'stack', id: top.id } : d.candidates[0];
      }
      case 'pump':
        return asTarget(this.trickTarget(g, p, d.card)) ?? asTarget(this.threatened(g, p, mine)) ?? asTarget(bestOf(mine, (q) => threat(g, q))) ?? d.candidates[0];
      case 'protect':
        return asTarget(this.threatened(g, p, mine)) ?? asTarget(bestOf(mine, (q) => threat(g, q))) ?? d.candidates[0];
      case 'steal': {
        if (e.from === 'battlefield') return asTarget(bestOf(perms, (q) => threat(g, q))) ?? d.candidates[0];
        // The library with the best creature in it.
        const seats = d.candidates.flatMap((t) => (t.kind === 'player' ? [t.seat] : []));
        const best = (seat: number) => Math.max(0, ...g.players[seat].library.filter((c) => c.isCreature).map((c) => c.value));
        return seats.length ? { kind: 'player', seat: seats.reduce((a, b) => (best(b) > best(a) ? b : a)) } : d.candidates[0];
      }
      case 'mill':
      case 'discard': {
        // Whoever is closest to running out, or holds the most cards.
        const seats = d.candidates.flatMap((t) => (t.kind === 'player' && t.seat !== p.seat ? [t.seat] : []));
        if (!seats.length) return d.candidates[0];
        const score = (seat: number) => (e.kind === 'mill' ? -g.players[seat].library.length : g.players[seat].hand.length);
        return { kind: 'player', seat: seats.reduce((a, c) => (score(c) > score(a) ? c : a)) };
      }
      case 'damagePlayer': {
        const amount = e.n === -1 ? 3 : e.n;
        const seat = this.playerToBurn(g, p, d.candidates.flatMap((t) => (t.kind === 'player' ? [t.seat] : [])), amount);
        return seat === null ? d.candidates[0] : { kind: 'player', seat };
      }
      default:
        return d.candidates[0];
    }
  }

  /** One of `mine` that a removal spell on the stack is aimed at. */
  private threatened(g: Game, p: PlayerState, mine: Perm[]): Perm | null {
    for (const item of g.stack) {
      if (item.controller === p.seat) continue;
      for (let i = 0; i < item.effects.length; i++) {
        const t = item.targets[i];
        if (item.effects[i].kind === 'removal' && t?.kind === 'perm') {
          const hit = mine.find((q) => q.id === t.id);
          if (hit) return hit;
        }
      }
    }
    return null;
  }

  private playerToBurn(g: Game, p: PlayerState, seats: number[], amount: number): number | null {
    const opps = seats.map((s) => g.players[s]).filter((o) => o.alive && o !== p);
    if (!opps.length) return null;
    const killable = opps.find((o) => o.life <= amount);
    if (killable) return killable.seat;
    const score = (o: PlayerState) => boardThreat(g, o) - o.life * 0.2;
    return opps.reduce((a, b) => (score(b) > score(a) ? b : a)).seat;
  }

  /** The best thing to remove among `candidates`, with how much it is worth. */
  private removalTarget(g: Game, p: PlayerState, e: Removal, x: number, candidates: Target[]): { target: Target; score: number } | null {
    if (e.mode === 'edict') {
      // The opponent whose worst creature is still a good one.
      let best: { target: Target; score: number } | null = null;
      for (const t of candidates) {
        if (t.kind !== 'player') continue;
        const creatures = g.players[t.seat].battlefield.filter((q) => q.card.isCreature);
        if (!creatures.length) continue;
        const score = Math.min(...creatures.map((c) => threat(g, c)));
        if (!best || score > best.score) best = { target: t, score };
      }
      return best;
    }
    const amount = e.amount === -1 ? Math.max(x, 1) : e.amount;
    const fighter = e.mode === 'fight' ? p.battlefield.filter((q) => q.card.isCreature).reduce<Perm | null>((a, b) => (!a || g.power(b) > g.power(a) ? b : a), null) : null;

    let best: { target: Target; score: number } | null = null;
    for (const t of candidates) {
      let score = 0;
      if (t.kind === 'player') {
        // "Any target" burn: only go face to finish someone.
        const o = g.players[t.seat];
        if (o === p || o.life > amount) continue;
        score = 50;
      } else if (t.kind === 'perm') {
        const perm = g.findPerm(t.id);
        if (!perm || perm.seat === p.seat || !removalMatches(e.target, perm.card)) continue;
        if (e.mode === 'destroy' && g.hasKw(perm, 'indestructible')) continue;
        if (e.mode === 'damage' && amount < g.toughness(perm) - perm.damage) continue;
        if (e.mode === 'damage' && g.hasKw(perm, 'indestructible')) continue;
        if (e.mode === 'fight' && (!fighter || (g.power(fighter) < g.toughness(perm) - perm.damage && !g.hasKw(fighter, 'deathtouch')))) continue;
        const leader = boardThreat(g, g.players[perm.seat]) > 15 ? 1.2 : 1;
        score = threat(g, perm) * leader;
        if (g.hasKw(perm, 'ward')) score *= 0.6;
        if (e.mode === 'bounce') score *= perm.token ? 1.3 : 0.7;
      } else continue;
      if (!best || score > best.score) best = { target: t, score };
    }
    return best;
  }

  private wipeIsGood(g: Game, p: PlayerState, e: Wipe, x: number): boolean {
    const creaturesOnly = e.target === 'creatures';
    const affects = (perm: Perm) => {
      if (perm.card.isLand) return false;
      if (creaturesOnly && !perm.card.isCreature) return false;
      if (e.mode === 'damage') return perm.card.isCreature && (e.amount === -1 ? x : e.amount) >= g.toughness(perm);
      if (e.mode === 'destroy' && g.hasKw(perm, 'indestructible')) return false;
      return true;
    };
    let mine = 0;
    if (!e.oneSided) for (const perm of p.battlefield) if (affects(perm)) mine += threat(g, perm);
    let theirs = 0;
    let incoming = 0;
    for (const o of g.opponents(p)) {
      for (const perm of o.battlefield) {
        if (affects(perm)) theirs += threat(g, perm);
        if (perm.card.isCreature) incoming += g.power(perm);
      }
    }
    if (e.oneSided) return theirs >= 6;
    if (incoming >= p.life && theirs > mine) return true;
    return theirs >= 10 && theirs >= mine * 1.6 + 4;
  }

  // -------------------------------------------------------------------------
  // Combat
  // -------------------------------------------------------------------------

  private readyAttackers(g: Game, p: PlayerState): Perm[] {
    return g.attackCandidates(p).filter((c) => g.power(c) > 0);
  }

  private attackScore(g: Game, o: PlayerState, blockers: Perm[], unblockable: number, total: number): number {
    let score = 0;
    if (unblockable >= o.life) score += 100;
    else if (total - blockers.length * 2 >= o.life) score += 25;
    score += boardThreat(g, o) * 0.4;
    score += (40 - o.life) * 0.4;
    score -= blockers.reduce((s, b) => s + g.power(b), 0) * 0.3;
    return score;
  }

  private attack(g: Game, p: PlayerState, candidateIds: number[], defenderSeats: number[]): AttackDeclaration[] {
    let candidates = candidateIds.map((id) => g.findPerm(id)).filter((q): q is Perm => q !== null && g.power(q) > 0);
    const opps = defenderSeats.map((s) => g.players[s]).filter((o) => o.alive);
    if (!candidates.length || !opps.length) return [];

    // Main target: who is most worth hitting, and can be hit.
    let main = opps[0];
    let mainScore = -Infinity;
    for (const o of opps) {
      const blockers = o.battlefield.filter((b) => b.card.isCreature && !b.tapped);
      let unblockable = 0;
      let total = 0;
      for (const a of candidates) {
        total += hitDamage(g, a);
        if (!blockers.some((b) => g.canBlock(b, a))) unblockable += hitDamage(g, a);
      }
      const score = this.attackScore(g, o, blockers, unblockable, total) + this.rng.next() * 8;
      if (score > mainScore) {
        main = o;
        mainScore = score;
      }
    }

    // Keep blockers home if the table could kill us on the crack-back.
    let crackBack = 0;
    for (const o of opps) {
      let power = 0;
      for (const perm of o.battlefield) if (perm.card.isCreature) power += hitDamage(g, perm);
      crackBack = Math.max(crackBack, power);
    }
    if (crackBack >= p.life) {
      const keep = candidates.filter((c) => !g.hasKw(c, 'vigilance')).sort((a, b) => g.toughness(b) - g.toughness(a)).slice(0, 2);
      candidates = candidates.filter((c) => !keep.includes(c));
    }

    // Each creature attacks the main target if that is sensible, otherwise any
    // other opponent it can hit safely.
    const totalDamage = candidates.reduce((s, a) => s + hitDamage(g, a), 0);
    const order = [main, ...opps.filter((o) => o !== main).sort((a, b) => a.life - b.life)];
    const out: AttackDeclaration[] = [];
    for (const a of candidates) {
      for (const o of order) {
        const isMain = o === main;
        const blockers = o.battlefield.filter((b) => b.card.isCreature && !b.tapped && g.canBlock(b, a));
        // A lethal-looking alpha strike, or so many attackers that most get through.
        const alpha = isMain && (totalDamage - blockers.length * 3 >= o.life || candidates.length >= blockers.length + 2);
        const badBlock = blockers.some((b) => !survives(g, a, b) && survives(g, b, a));
        const trade = blockers.some((b) => !survives(g, a, b));
        let go = !badBlock || alpha;
        if (!go && isMain && !trade) go = true;
        if (!go && isMain && a.token && this.rng.chance(0.4 * this.aggression)) go = true;
        if (!go && isMain && this.rng.chance(0.1 * this.aggression)) go = true;
        if (go) {
          out.push({ attacker: a.id, defender: o.seat });
          break;
        }
      }
    }
    return out;
  }

  private block(g: Game, d: PlayerState, attackerIds: number[], candidateIds: number[]): BlockDeclaration[] {
    const attackers = attackerIds.map((id) => g.findPerm(id)).filter((q): q is Perm => q !== null);
    const available = candidateIds.map((id) => g.findPerm(id)).filter((q): q is Perm => q !== null);
    const blocks = new Map<Perm, Perm[]>();
    const take = (b: Perm) => available.splice(available.indexOf(b), 1);
    const least = (list: Perm[]) => list.reduce((x, y) => (threat(g, y) < threat(g, x) ? y : x));
    const sorted = [...attackers].sort((a, b) => hitDamage(g, b) - hitDamage(g, a));

    // 1. Blocks where our creature kills the attacker and survives.
    for (const a of sorted) {
      if (g.hasKw(a, 'menace')) continue;
      const good = available.filter((b) => g.canBlock(b, a) && kills(g, b, a) && survives(g, b, a));
      if (good.length) {
        const b = least(good);
        blocks.set(a, [b]);
        take(b);
      }
    }
    // 2. Trades that favour us.
    for (const a of sorted) {
      if (blocks.has(a) || g.hasKw(a, 'menace')) continue;
      const trade = available.filter((b) => g.canBlock(b, a) && kills(g, b, a) && threat(g, b) < threat(g, a));
      if (trade.length) {
        const b = least(trade);
        blocks.set(a, [b]);
        take(b);
      }
    }
    // 3. Walls: a creature that survives the hit blocks for free.
    for (const a of sorted) {
      if (blocks.has(a) || g.hasKw(a, 'menace')) continue;
      const wall = available.filter((b) => g.canBlock(b, a) && survives(g, b, a));
      if (wall.length) {
        const b = least(wall);
        blocks.set(a, [b]);
        take(b);
      }
    }
    // 4. Chump-block if the unblocked damage would kill us (or reach 21 commander damage).
    const incoming = () => {
      let total = 0;
      let commanderLethal = false;
      for (const a of attackers) {
        const bs = blocks.get(a);
        if (bs) {
          if (g.hasKw(a, 'trample')) total += Math.max(0, hitDamage(g, a) - bs.reduce((s, b) => s + g.toughness(b), 0));
          continue;
        }
        total += hitDamage(g, a);
        if (a.isCommander && (d.commanderDamage.get(`${a.seat}:${a.card.name}`) ?? 0) + hitDamage(g, a) >= 21) commanderLethal = true;
      }
      return { total, commanderLethal };
    };
    for (const a of sorted) {
      const { total, commanderLethal } = incoming();
      if (total < d.life && !commanderLethal) break;
      if (blocks.has(a)) continue;
      const need = g.hasKw(a, 'menace') ? 2 : 1;
      const chumps = available.filter((b) => g.canBlock(b, a)).sort((x, y) => threat(g, x) - threat(g, y)).slice(0, need);
      if (chumps.length < need) continue;
      blocks.set(a, chumps);
      chumps.forEach(take);
    }

    const out: BlockDeclaration[] = [];
    for (const [a, bs] of blocks) for (const b of bs) out.push({ blocker: b.id, attacker: a.id });
    return out;
  }

  // -------------------------------------------------------------------------
  // Other choices
  // -------------------------------------------------------------------------

  private choose(g: Game, p: PlayerState, d: Extract<Decision, { kind: 'choose' }>): number[] {
    const indexes = d.options.map((_, i) => i);
    const top = (score: (i: number) => number, count: number) => [...indexes].sort((a, b) => score(b) - score(a)).slice(0, count);
    const card = (i: number) => d.options[i].card!;
    const perm = (i: number) => g.findPerm(d.options[i].permId ?? null);

    switch (d.reason) {
      case 'bottom':
      case 'discard': {
        const lands = p.hand.filter((c) => c.isLand).length;
        return top((i) => -this.cardScore(g, p, card(i), lands), d.min);
      }
      case 'tutor': {
        const needLand = g.landCount(p) < 4 && !p.hand.some((c) => c.isLand);
        return top((i) => (card(i).isLand === needLand ? 100 : 0) + card(i).value, 1);
      }
      case 'recursion':
        return top((i) => card(i).value, d.max);
      case 'sacrifice':
        return top((i) => -(perm(i) ? threat(g, perm(i)!) : 0), d.min);
      case 'ramp': {
        // Fetch the color we have the fewest sources of.
        const counts = new Map<Mana, number>();
        for (const q of p.battlefield) {
          const prod = q.landInfo?.produces;
          if (!prod) continue;
          for (const m of prod === 'any' ? ALL_COLORS : prod) counts.set(m, (counts.get(m) ?? 0) + 1);
        }
        return top((i) => {
          const prod = card(i).land?.produces;
          return -(counts.get(!prod || prod === 'any' ? 'C' : prod[0]) ?? 0);
        }, 1);
      }
      case 'extraLand':
        return [0];
      case 'counters':
      case 'fighter':
        return top((i) => (perm(i) ? g.power(perm(i)!) : 0), 1);
      case 'clone':
        // The scariest creature, but not a legend we already control (the copy would die to the legend rule).
        return top((i) => {
          const q = perm(i);
          if (!q) return 0;
          return threat(g, q) - (q.card.isLegendary && q.seat === p.seat ? 100 : 0);
        }, 1);
      case 'scry': {
        // Send away lands when flooded, expensive spells when short of lands.
        const lands = g.landCount(p);
        const landsInHand = p.hand.filter((c) => c.isLand).length;
        return indexes.filter((i) => {
          const c = card(i);
          if (c.isLand) return lands + landsInHand >= 6;
          if (!c.modeled) return true;
          return c.cmc > lands + 3;
        });
      }
      case 'cheat':
      case 'take':
        return top((i) => card(i).value + card(i).cmc, 1);
    }
    return top(() => 0, d.min);
  }
}
