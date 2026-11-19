// Proliferate's own Magic AI: a heuristic player that answers every decision
// the rules engine asks for: mulligans, land drops, what to cast and when,
// targets, attacks, blocks and responses on the stack.
//
// It reads the same public game state a person at the table would, plus its
// own hand. It never looks at other players' hands or at any library.

import { isIncubator } from '../engine/artifactTokens';
import { Rng } from '../engine/rng';
import type { Effect, Mana, SimCard } from '../engine/types';
import { cardColors, chargeUse, commanderName, counterMatches, FOOD, isAura, isInstantSpeed, type Game } from './game';
import type {
  Action, Agent, Answer, AttackDeclaration, BlockDeclaration, Decision, Perm, PlayerState, PriorityAnswer, StackItem, Target,
} from './types';
import { COMBOS, missingComboPieces, UPKEEP_WINS, WINCON_NAMES } from './wincons';

const ALT_WIN_NAMES = new Set(Object.keys(UPKEEP_WINS));

const ALL_COLORS: Mana[] = ['W', 'U', 'B', 'R', 'G'];
const REACTIVE_KINDS = new Set(['counter', 'pump', 'protect', 'copySpell', 'fog', 'redirect', 'preventNext', 'deathShield']);
/** What a copy aimed at our own creature can carry and still help it (Ivy). */
const KIND_TO_US = new Set(['pump', 'protect', 'counters', 'kwCounter', 'untap', 'gainLife', 'draw']);

export interface BotOptions {
  /** How eagerly it attacks: about 0.6 (careful) to 1.5 (reckless). Default: random 0.8–1.3. */
  aggression?: number;
}

type Removal = Extract<Effect, { kind: 'removal' }>;
type Wipe = Extract<Effect, { kind: 'wipe' }>;
type Pump = Extract<Effect, { kind: 'pump' }>;
type CastAction = Extract<Action, { type: 'cast' }>;
type HandAction = Extract<Action, { type: 'hand' }>;

/** The card as this cast action would cast it: with its spree modes, kicker, emerge discount or other cost. */
function castAs(g: Game, p: PlayerState, a: CastAction): SimCard {
  if (a.free) return g.freeCard(a.card);
  if (a.modes) return g.spreeCard(a.card, a.modes);
  if (a.kick) return g.kickedCard(a.card, a.kick);
  if (a.from === 'alt' && a.card.altCost?.emerge) return g.emergeCard(a.card, g.emergeDiscount(p, a.card));
  return g.castCard(a.card, a.door ? 'door' : a.faceDown ? 'faceDown' : a.mutate ? 'mutate' : a.from, p.seat);
}

/** True if `p` controls a permanent that turns drawing from an empty library into a win (Laboratory Maniac). */
function winsOnEmptyDraw(p: PlayerState): boolean {
  return p.battlefield.some((q) => q.card.effects.some((e) => e.kind === 'winOnEmptyDraw'));
}

/** Life each opponent loses whenever one of `p`'s creatures dies (Zulaport Cutthroat, Blood Artist). */
function deathDrain(p: PlayerState): number {
  let n = 0;
  for (const q of p.battlefield) {
    for (const e of q.card.effects) {
      if (e.when === 'creatureDies' && e.scope !== 'self' && e.scope !== 'attached' && (e.kind === 'drain' || e.kind === 'damagePlayer') && e.n > 0) n += e.n;
    }
  }
  return n;
}

/** The plan a deck is built around besides combat, from its own decklist. */
interface DeckPlan {
  /** Cards that mill opponents. */
  mill: number;
  /** Cards that drain or burn players. */
  drain: number;
  /** Cards that destroy lands or punish them (Blood Moon, Armageddon, Strip Mine). */
  landHate: number;
}

const LAND_HATE = new Set(['landRule', 'tapPunish', 'landWipe', 'landSac', 'nonbasicBurn', 'landDiesPunish']);

function deckPlan(p: PlayerState): DeckPlan {
  const plan: DeckPlan = { mill: 0, drain: 0, landHate: 0 };
  for (const c of [...p.deck.commanders, ...p.deck.cards.flatMap((e) => Array<SimCard>(e.count).fill(e.card))]) {
    if (c.effects.some((e) => e.kind === 'mill' && e.who !== 'you' && e.who !== 'all')) plan.mill++;
    if (c.effects.some((e) => e.kind === 'drain' || e.kind === 'damagePlayer')) plan.drain++;
    if (c.effects.some((e) => LAND_HATE.has(e.kind) || (e.kind === 'removal' && (e.target === 'land' || e.target === 'nonbasicLand')))) plan.landHate++;
  }
  return plan;
}

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
  // Combo pieces and alternative win conditions are worth answering even when they look harmless.
  if (WINCON_NAMES.has(card.name) || card.effects.some((e) => e.kind === 'winOnEmptyDraw' || e.kind === 'winIf')) t += 6;
  // Platinum Angel, Phyrexian Unlife: what keeps a player at 0 or less life in the game.
  const shield = card.effects.find((e) => e.kind === 'cantLose' && e.when === 'static');
  if (shield && shield.kind === 'cantLose') t += g.players[perm.seat].life <= 0 ? 30 : shield.lifeOnly ? 2 : 6;
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

/**
 * How far ahead of the table a player is, by board and life together. A table
 * of people gangs up on the leader; bots that only chase the lowest life total
 * let a lifegain deck run away with the game.
 */
export function standing(g: Game, p: PlayerState): number {
  return boardThreat(g, p) + p.life * 0.4 + p.hand.length;
}

/** How much `o` leads the other opponents of `seat` (0 if not ahead). */
export function archenemyLead(g: Game, o: PlayerState, seat: number): number {
  const others = g.players.filter((q) => q.alive && q !== o && q.seat !== seat);
  if (!others.length) return 0;
  const avg = others.reduce((s, q) => s + standing(g, q), 0) / others.length;
  return Math.max(0, standing(g, o) - avg);
}

/** Damage `a` deals in one combat (double strike counts twice). */
function hitDamage(g: Game, a: Perm): number {
  return g.power(a) * (g.hasKw(a, 'double strike') ? 2 : 1);
}

function kills(g: Game, attacker: Perm, defender: Perm): boolean {
  return g.hasKw(attacker, 'deathtouch') ? g.power(attacker) > 0 : hitDamage(g, attacker) >= g.toughness(defender) - defender.damage;
}

/** Roughly how much a spell or ability on the stack gains its controller, to judge whether copying it is worth it. */
function stackWorth(item: StackItem): number {
  let v = 0;
  for (const e of item.effects) {
    switch (e.kind) {
      case 'draw': v += 1.5 * (e.n === -1 ? Math.max(item.x, 1) : e.n); break;
      case 'removal': case 'tutor': case 'steal': v += 3; break;
      case 'extraTurn': v += 6; break;
      case 'tokens': v += Math.max(e.n, 1) * (e.power + e.toughness) * 0.4; break;
      case 'treasure': case 'ramp': v += 1.5 * ('n' in e ? e.n : e.lands); break;
      case 'drain': v += 1.5 * (e.n === -1 ? Math.max(item.x, 1) : e.n); break;
      case 'recursion': v += 2 * e.n; break;
      case 'counters': v += e.all ? 2 : 1; break;
      case 'damagePlayer': v += 0.5 * (e.n === -1 ? Math.max(item.x, 1) : e.n); break;
      case 'tokenCopy': v += 3 * Math.max(e.n, 1); break;
      case 'takeCard': case 'copyNext': v += 2; break;
      case 'wipe': case 'counter': case 'copySpell': case 'redirect': break;
      default: v += 0.5;
    }
  }
  return v;
}

/** How much a permanent's enters abilities are worth doing again (blink). */
export function etbWorth(perm: Perm): number {
  const card = perm.printed ?? perm.card;
  let v = 0;
  for (const e of card.effects) {
    if (e.when !== 'resolve') continue;
    switch (e.kind) {
      case 'removal': v += 4; break;
      case 'steal': v += 6; break;
      case 'tokenCopy': v += 3 * Math.max(e.n, 1); break;
      case 'draw': v += 1.5 * Math.max(e.n, 1); break;
      case 'tokens': v += Math.max(e.n, 1) * (e.power + e.toughness) * 0.4; break;
      case 'treasure': v += e.n; break;
      case 'ramp': v += 2.5 * Math.max(e.lands, 1); break;
      case 'tutor': v += 3; break;
      case 'recursion': v += 2 * e.n; break;
      case 'drain': v += 1.5 * Math.max(e.n, 1); break;
      case 'untap': v += e.what === 'lands' ? Math.min(e.n, 5) : 1; break;
      case 'wipe': v -= 5; break;
      default: v += 0.5;
    }
  }
  // What it loses by leaving: counters, and Sagas start over (a good thing only for their first chapters).
  v -= perm.counters * 0.8;
  if (perm.isCommander && v < 3) v -= 1;
  return v;
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
  private plan: DeckPlan | null = null;

  constructor(readonly seat: number, seed: number, opts: BotOptions = {}) {
    this.rng = new Rng((seed ^ ((seat + 1) * 0x9e3779b1)) >>> 0);
    this.aggression = opts.aggression ?? 0.8 + this.rng.next() * 0.5;
  }

  decide(g: Game, d: Decision): Answer {
    const p = g.players[d.seat];
    this.plan ??= deckPlan(p);
    switch (d.kind) {
      case 'priority': return this.priority(g, p, d.actions);
      case 'target': return this.target(g, p, d);
      case 'attackers': return this.attack(g, p, d.candidates, d.defenders, d.goaded ?? []);
      case 'blockers': return this.block(g, p, d.attackers, d.candidates);
      case 'choose': return this.choose(g, p, d);
      case 'confirm':
        if (d.reason === 'mulligan') return !this.keepable(p.hand, p.mulligans);
        // Vihaan: Treasures become 3/3 attackers when there are enough of them to matter.
        if (d.reason === 'animate') return p.treasures >= 3;
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
    const pick = (a: Action | undefined, x = a?.type === 'activate' && a.effect.loyaltyX ? this.loyaltyX(g, p, a) : 0): PriorityAnswer => {
      this.castingX = x;
      return { action: a ? Math.max(0, actions.indexOf(a)) : 0, x };
    };
    // A Pact is only cast when its upkeep payment will be there.
    const casts = actions.filter((a): a is CastAction => a.type === 'cast' && this.pactPayable(g, p, a.card));
    const top = g.stack[g.stack.length - 1];

    // Madness and miracle: now or never (rules 702.35, 702.94).
    const windowCast = this.chooseWindow(g, p, casts);
    if (windowCast) return pick(windowCast.action, windowCast.x);

    // Something is on the stack: answer it or let it resolve.
    if (top) {
      if (this.considered.has(top.id)) return pick(undefined);
      this.considered.add(top.id);
      if (top.controller === p.seat) return pick(this.copyOwn(top, actions));
      return pick(this.response(g, p, top, casts) ?? this.selfSave(p, top, actions) ?? this.redirect(g, p, top, actions));
    }

    const myTurn = g.activeSeat === p.seat;
    // A spell or ability that knocks an opponent out (or mills them out) comes before anything else.
    if ((myTurn && (g.step === 'main1' || g.step === 'main2')) || (g.step === 'end' && g.nextAliveSeat(g.activeSeat) === p.seat)) {
      const kill = this.lethalAction(g, p, actions);
      if (kill) return pick(kill.action, kill.x);
    }
    // Triskaidekaphile: hold exactly thirteen cards going into our upkeep.
    const holding = this.holdingThirteen(p);
    if (holding && myTurn && p.hand.length <= 13 && (g.step === 'main1' || g.step === 'main2')) return pick(undefined);
    if (holding && !myTurn && g.step === 'end' && g.nextAliveSeat(g.activeSeat) === p.seat && p.hand.length < 13) {
      const draw = actions.find((a) => a.type === 'activate' && a.effect.kind === 'draw' && g.findPerm(a.permId)?.card.name === 'Triskaidekaphile');
      if (draw) return pick(draw);
    }
    if (myTurn && (g.step === 'main1' || g.step === 'main2')) {
      const land = this.chooseLand(g, p, actions);
      if (land) return pick(land);
      const equip = this.chooseEquip(g, actions);
      if (equip) return pick(equip);
      // Turn face-down creatures face up before combat: it is like casting them, but they can attack now.
      const up = this.chooseFaceUp(g, actions);
      if (up) return pick(up);
      const spell = this.chooseSpell(g, p, casts, false);
      if (spell) return pick(spell.action, spell.x);
      const back = this.chooseGraveyard(g, p, actions);
      if (back) return pick(back);
      // Suspend, plot and foretell with mana left over; transmute and channel when it pays.
      const hand = this.chooseHand(g, p, actions);
      if (hand) return pick(hand);
      // Crew a Vehicle when it hits harder than the creatures that would drive it.
      const crew = actions.find((a) => {
        if (a.type !== 'crew') return false;
        const vehicle = g.findPerm(a.permId);
        const drivers = vehicle ? g.crewFor(p, vehicle) : null;
        if (!vehicle || !drivers || vehicle.sick) return false;
        const lost = drivers.filter((q) => !q.sick).reduce((n, q) => n + g.power(q), 0);
        return vehicle.card.power > lost;
      });
      if (crew) return pick(crew);
      // Station a Spacecraft or Planet with a creature that isn't going to attack.
      const station = actions.find((a) => a.type === 'station' && this.stationDriver(g, p, a.permId));
      if (station) return pick(station);
      // Classes: gain the next level once there is nothing better to spend the mana on.
      const level = actions.find((a) => a.type === 'level');
      if (level) return pick(level);
      // Rooms: unlock the other door once there is nothing better to do, unless unlocking it would hurt us.
      const unlock = actions.find((a) => a.type === 'unlock' && this.unlockWorth(g, p, a.permId));
      if (unlock) return pick(unlock);
      if (g.step === 'main2') return pick(this.chooseAbility(g, p, actions) ?? this.chooseCycle(g, p, actions));
      // Before combat: haste and evasion abilities, tapping a blocker, hasty copies (Kiki-Jiki), borrowed attackers, and keeping a blocker out of the way (Zirda).
      return pick(this.chooseAbility(g, p, actions.filter((a) => a.type === 'activate' && (a.effect.kind === 'pump' || a.effect.kind === 'overrun' || a.effect.kind === 'animate' || a.effect.kind === 'tap' || a.effect.kind === 'tokenCopy' || a.effect.kind === 'steal' || a.effect.kind === 'copyNext' || a.effect.kind === 'becomeCreature'))) ?? this.chooseCombatShaping(g, p, actions));
    }

    // Before an opponent's attack: make their creatures attack (Bident of Thassa), or stop the one that would hit us hardest (Endbringer).
    if (!myTurn && g.step === 'beginCombat') {
      const shape = this.chooseCombatShaping(g, p, actions);
      if (shape) return pick(shape);
    }

    // An opponent's beginning of combat: tap their biggest attacker (Mind Games, Thassa, Ring of the Lucii).
    if (!myTurn && g.step === 'beginCombat' && this.tapWorthNow(g, p)) {
      const spell = this.chooseSpell(g, p, casts.filter((a) => a.card.effects.some((e) => e.kind === 'tap' && e.when === 'resolve')), true);
      if (spell) return pick(spell.action, spell.x);
      const tap = this.chooseAbility(g, p, actions.filter((a) => a.type === 'activate' && a.effect.kind === 'tap'));
      if (tap) return pick(tap);
    }

    // Combat tricks once blockers are known, then abilities that save or pump a creature in the fight.
    if (g.step === 'declareBlockers' && myTurn) {
      const ninja = this.chooseNinjutsu(g, actions);
      if (ninja) return pick(ninja);
    }
    if (g.step === 'declareBlockers' && !myTurn) {
      const fog = this.chooseFog(g, p, actions);
      if (fog) return pick(fog);
    }
    if (g.step === 'declareBlockers') return pick(this.chooseTrick(g, p, casts) ?? this.chooseAbility(g, p, actions.filter((a) => a.type === 'activate' && a.effect.kind === 'pump' && a.effect.self)) ?? this.combatProtect(g, p, actions));

    // The end step before our own turn: use instants and abilities with mana that would otherwise be wasted.
    if (!myTurn && g.step === 'end' && g.nextAliveSeat(g.activeSeat) === p.seat) {
      const up = this.chooseFaceUp(g, actions);
      if (up) return pick(up);
      const spell = this.chooseSpell(g, p, casts, true);
      if (spell) return pick(spell.action, spell.x);
      return pick(this.chooseAbility(g, p, actions) ?? this.chooseGraveyard(g, p, actions) ?? this.chooseHand(g, p, actions) ?? this.chooseCycle(g, p, actions));
    }
    return pick(undefined);
  }

  /**
   * Bring something back from the graveyard with mana that would otherwise go unused: unearth before combat,
   * embalm and "return ~ from your graveyard" abilities, cards to hand when the hand is running low.
   */
  private chooseGraveyard(g: Game, p: PlayerState, actions: Action[]): Action | undefined {
    let best: Action | undefined;
    let bestScore = 0;
    for (const a of actions) {
      if (a.type !== 'graveyard') continue;
      const use = a.card.graveyard!;
      let score = a.card.value;
      if (use.to === 'hand') score = p.hand.length <= 2 ? a.card.value : 0;
      // Unearth is a one-turn attacker: only before combat, and only if it hits.
      if (use.exileAtEnd) score = g.step === 'main1' && a.card.power >= 2 ? a.card.power : 0;
      if (use.sacCreature) score -= 3;
      if (score > bestScore) {
        best = a;
        bestScore = score;
      }
    }
    return best;
  }

  /** Triskaidekaphile on the battlefield and a hand close enough to thirteen to aim for it. */
  private holdingThirteen(p: PlayerState): boolean {
    return p.hand.length >= 9 && p.battlefield.some((q) => q.card.name === 'Triskaidekaphile');
  }

  /**
   * How much life `effects` would take from opponent `o`, and whether they
   * would mill `o` out. `card` is the card being cast, if any (its own pips
   * count toward devotion once it is on the battlefield).
   */
  private damageTo(g: Game, p: PlayerState, effects: Effect[], x: number, o: PlayerState, card: SimCard | null): { life: number; milledOut: boolean } {
    let life = 0;
    let single = 0;
    let milled = 0;
    for (const e of effects) {
      if (e.kind === 'drain') {
        const own = card && !card.isInstant && !card.isSorcery && e.devotion ? card.cost.pips.filter((pip) => pip.includes(e.devotion!)).length : 0;
        life += e.devotion ? g.devotion(p, e.devotion) + own : e.n === -1 ? Math.max(x, 1) : e.n;
      } else if (e.kind === 'damagePlayer') single = Math.max(single, e.n === -1 ? Math.max(x, 1) : e.n);
      else if (e.kind === 'removal' && e.mode === 'damage' && e.anyTarget && !e.each) single = Math.max(single, e.amount === -1 ? Math.max(x, 1) : e.amount);
      else if (e.kind === 'mill' && e.who !== 'you') {
        const n = e.n === -2 ? Math.ceil(o.library.length / 2) : e.n === -1 ? Math.max(x, 1) * 2 : e.n;
        // Milling everyone also mills us: only if we have more cards left, or win on an empty library.
        if (e.who === 'all' && p.library.length <= Math.max(n, o.library.length) && !winsOnEmptyDraw(p)) continue;
        milled += n;
      }
    }
    return { life: life + single, milledOut: o.library.length > 0 && milled >= o.library.length };
  }

  /** True if these effects would eliminate an opponent outright, or leave them with no library. */
  private finishes(g: Game, p: PlayerState, effects: Effect[], x: number, card: SimCard | null): boolean {
    for (const o of g.opponents(p)) {
      if (o.shielded) continue;
      const hit = this.damageTo(g, p, effects, x, o, card);
      if ((hit.life > 0 && hit.life >= o.life) || hit.milledOut) return true;
    }
    return false;
  }

  /** A spell or ability that finishes an opponent off now, if there is one. */
  private lethalAction(g: Game, p: PlayerState, actions: Action[]): { action: Action; x: number } | undefined {
    const instantWindow = g.activeSeat !== p.seat;
    for (const a of actions) {
      if (a.type === 'cast') {
        const card = a.free ? g.freeCard(a.card) : g.castCard(a.card, a.from, p.seat);
        if (instantWindow && !isInstantSpeed(card)) continue;
        if (card.xFromLife || (card.cost.x > 0 && a.maxX < 1)) continue;
        const effects = card.effects.filter((e) => e.when === 'resolve');
        if (this.finishes(g, p, effects, a.maxX, card)) return { action: a, x: a.maxX };
      } else if (a.type === 'activate') {
        if ((a.effect.activation?.cost.life ?? 0) >= p.life) continue;
        if (a.effect.activation?.sacCreature && !p.battlefield.some((q) => q.card.isCreature && q.id !== a.permId)) continue;
        if (this.finishes(g, p, [a.effect], 0, null)) return { action: a, x: 0 };
        // A sacrifice outlet with enough death triggers out: each creature fed to it drains the table.
        const perDeath = deathDrain(p);
        if (a.effect.activation?.sacCreature && perDeath > 0) {
          const fodder = p.battlefield.filter((q) => q.card.isCreature && q.id !== a.permId).length;
          if (g.opponents(p).some((o) => !o.shielded && o.life <= fodder * perDeath)) return { action: a, x: 0 };
        }
      }
    }
    return undefined;
  }

  /** The face-down creature whose real card is best, if it can be turned face up. */
  /**
   * Ninjutsu: swap in the ninja whose card beats what it replaces, returning the least valuable
   * unblocked attacker (it can be cast again). Ninjas that do something on a hit are worth more.
   */
  private chooseNinjutsu(g: Game, actions: Action[]): Action | undefined {
    let best: Action | undefined;
    let bestGain = 0;
    for (const a of actions) {
      if (a.type !== 'ninjutsu') continue;
      const out = g.findPerm(a.permId);
      if (!out) continue;
      const onHit = a.card.effects.some((e) => e.when === 'combatDamage') ? 3 : 0;
      const gain = a.card.value + onHit + a.card.power - out.card.value - g.power(out) + (out.card.effects.some((e) => e.when === 'resolve') ? 1.5 : 0) - (out.isCommander ? 3 : 0);
      if (gain > bestGain) {
        best = a;
        bestGain = gain;
      }
    }
    return best;
  }

  private chooseFaceUp(g: Game, actions: Action[]): Action | undefined {
    let best: Action | undefined;
    let bestValue = 2;
    for (const a of actions) {
      if (a.type !== 'turnFaceUp') continue;
      const real = g.findPerm(a.permId)?.faceDown;
      if (real && real.value > bestValue) {
        best = a;
        bestValue = real.value;
      }
    }
    return best;
  }

  /** Cycle cards that are no use where the game stands: land searches when short of lands, spells too dear to cast soon, spare lands late. */
  private chooseCycle(g: Game, p: PlayerState, actions: Action[]): Action | undefined {
    const lands = g.landCount(p);
    return actions.find((a) => {
      if (a.type !== 'cycle') return false;
      const card = a.card;
      if (card.cycling?.land) return lands < 5 || card.cmc > lands + 1;
      if (card.isLand) return lands >= 6;
      return card.cmc > lands + 2 || (card.effects.length === 0 && !card.isCreature);
    });
  }

  /** Copy our own spell or triggered ability when it is worth having twice (Strionic Resonator, Twincast). */
  private copyOwn(top: StackItem, actions: Action[]): Action | undefined {
    if (top.copy || stackWorth(top) < (top.kind === 'ability' ? 1.5 : 3)) return undefined;
    const isSpell = top.kind === 'spell' && (top.card.isInstant || top.card.isSorcery);
    return actions.find((a) => {
      const e = a.type === 'activate' ? a.effect : a.type === 'cast' ? a.card.effects.find((f) => f.kind === 'copySpell') : undefined;
      if (!e || e.kind !== 'copySpell' || (a.type === 'cast' && a.from === 'alt')) return false;
      return e.what === 'ability' ? top.kind === 'ability' && top.sourceId !== (a.type === 'activate' ? a.permId : null) : e.what === 'spell' && isSpell;
    });
  }

  /** Counter an opponent's spell, copy it, or protect a permanent it targets. */
  private response(g: Game, p: PlayerState, top: StackItem, casts: CastAction[]): Action | undefined {
    if (top.kind === 'spell') {
      const counters = casts.filter((a) => castAs(g, p, a).effects.some((e) => e.kind === 'counter' && e.when === 'resolve' && counterMatches(e.target, top.card)));
      // Pay with mana when possible; a free counter costs a card, so it is kept for what really matters.
      const counter = counters.find((a) => a.from !== 'alt') ?? counters.find(() => this.urgent(g, p, top));
      if (counter && this.wantsToCounter(g, p, top)) return counter;
      // Copy a good instant or sorcery for ourselves (Narset's Reversal, Twincast).
      if ((top.card.isInstant || top.card.isSorcery) && stackWorth(top) >= 3) {
        const copy = casts.find((a) => a.from !== 'alt' && a.card.effects.some((e) => e.kind === 'copySpell' && e.what === 'spell' && !e.yours));
        if (copy) return copy;
      }
    }
    // A board wipe that would cost us a real board: protect all of it if we can.
    if (top.controller !== p.seat && top.effects.some((e) => e.kind === 'wipe') && boardThreat(g, p, true) > 6) {
      const shield = casts.find((a) => isInstantSpeed(a.card) && a.card.effects.some((f) => (f.kind === 'protect' && f.all) || f.kind === 'deathShield'));
      if (shield) return shield;
    }
    // Is one of our better permanents about to be removed?
    for (let i = 0; i < top.effects.length; i++) {
      const e = top.effects[i];
      const t = top.targets[i];
      if (e.kind !== 'removal' || !t || t.kind !== 'perm') continue;
      const perm = g.findPerm(t.id);
      if (!perm || perm.seat !== p.seat || threat(g, perm) < 5) continue;
      // Protection, or a blink that makes the removal lose its target.
      const save = casts.find((a) => a.from !== 'alt' && isInstantSpeed(a.card) && a.card.effects.some((f) => f.kind === 'protect' || (f.kind === 'pump' && f.protect) || (f.kind === 'blink' && f.when === 'resolve' && (f.what === 'permanent' || perm.card.isCreature) && !perm.token)));
      if (save) return save;
    }
    return undefined;
  }

  /** Worth spending a card on (Force of Will): a commander, a bomb, or a spell that wrecks our board. */
  private urgent(g: Game, p: PlayerState, top: StackItem): boolean {
    if (top.isCommander || top.card.value >= 9 || top.effects.some((e) => e.kind === 'extraTurn')) return true;
    const wipe = top.effects.find((e): e is Wipe => e.kind === 'wipe');
    if (wipe && boardThreat(g, p, wipe.target === 'creatures') > 10) return true;
    return top.effects.some((e, i) => {
      const t = top.targets[i];
      const perm = t?.kind === 'perm' ? g.findPerm(t.id) : null;
      return e.kind === 'removal' && perm?.seat === p.seat && threat(g, perm) >= 9;
    });
  }

  /** How much an opponent's spell or ability on the stack hurts us through its targets: our permanents, us, or our spells. */
  private harm(g: Game, p: PlayerState, item: StackItem): number {
    if (item.controller === p.seat) return 0;
    let v = 0;
    item.effects.forEach((e, i) => {
      const t = item.targets[i];
      if (!t) return;
      if (t.kind === 'perm') {
        const q = g.findPerm(t.id);
        if (q?.seat === p.seat && !KIND_TO_US.has(e.kind)) v += Math.max(threat(g, q), 1);
      } else if (t.kind === 'player') {
        if (t.seat === p.seat && !KIND_TO_US.has(e.kind)) v += e.kind === 'damagePlayer' || e.kind === 'drain' ? 0.5 * Math.max(e.n === -1 ? item.x : e.n, 1) : 1.5;
      } else {
        const s = g.stack.find((o) => o.id === t.id);
        if (s?.controller === p.seat && e.kind === 'counter') v += s.card.value + stackWorth(s);
      }
    });
    return v;
  }

  /** Change the target of an opponent's spell that hurts us (Deflecting Swat, Bolt Bend), or pull it onto Spellskite. */
  private redirect(g: Game, p: PlayerState, top: StackItem, actions: Action[]): Action | undefined {
    const hurt = this.harm(g, p, top);
    if (hurt < 3) return undefined;
    return actions.find((a) => {
      const e = a.type === 'activate' ? a.effect : a.type === 'cast' && a.from !== 'alt' ? a.card.effects.find((f) => f.kind === 'redirect') : undefined;
      if (!e || e.kind !== 'redirect' || (a.type === 'cast' && !isInstantSpeed(a.card))) return false;
      const src = a.type === 'activate' ? g.findPerm(a.permId) : null;
      // Spellskite only helps when what it saves is worth more than Spellskite.
      if (e.to === 'self' && src && hurt <= threat(g, src) + 1) return false;
      return (g.targetCandidates(p, e, src) ?? []).some((t) => t.kind === 'stack' && t.id === top.id);
    });
  }

  /** Regenerate-style "~ gains indestructible" in answer to destroy or damage removal aimed at it. */
  private selfSave(p: PlayerState, top: StackItem, actions: Action[]): Action | undefined {
    if (top.controller === p.seat) return undefined;
    // Mother of Runes: protection from the color of a spell or ability aimed at one of our creatures.
    const aimed = top.targets.some((t) => t?.kind === 'perm' && p.battlefield.some((q) => q.id === t.id && q.card.isCreature)) && cardColors(top.card).length > 0
      && top.effects.some((e) => e.kind === 'removal' || e.kind === 'steal' || e.kind === 'stun' || e.kind === 'equip');
    if (aimed) {
      const shield = actions.find((a) => a.type === 'activate' && a.effect.kind === 'protectColor');
      if (shield) return shield;
    }
    return actions.find((a) => {
      if (a.type !== 'activate' || a.effect.kind !== 'pump' || !a.effect.self || !(a.effect.grant?.includes('indestructible') || a.effect.grant?.includes('regenerate'))) return false;
      // Regenerate (rule 701.19) also answers "destroy all creatures".
      if (a.effect.grant.includes('regenerate') && top.effects.some((e) => e.kind === 'wipe' && (e.mode === 'destroy' || e.mode === 'damage') && e.target !== 'artifacts')) return true;
      return top.effects.some((e, i) => e.kind === 'removal' && (e.mode === 'destroy' || e.mode === 'damage') && top.targets[i]?.kind === 'perm' && (top.targets[i] as { id: number }).id === a.permId);
    });
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
    // The last piece of a combo or an alternative win the caster already has the rest of.
    if (COMBOS.some((c) => c.pieces.some((g1) => g1.includes(top.card.name)) && c.pieces.every((g1) => g1.includes(top.card.name) || caster.battlefield.some((q) => g1.includes(q.card.name))))) return true;
    if (top.isCommander || top.card.value >= 9) return this.rng.chance(0.6);
    if (top.card.value >= 6) return this.rng.chance(0.25);
    return false;
  }

  /** Does this deck want its own graveyard (reanimation, flashback, escape and the like)? */
  private leansOnGraveyard(p: PlayerState): boolean {
    const uses = (c: SimCard) => !!c.flashback || !!c.graveyard || c.effects.some((e) => e.kind === 'recursion' || e.kind === 'entomb' || e.kind === 'graveyardPlay');
    let n = 0;
    for (const entry of p.deck.cards) if (uses(entry.card)) n += entry.count;
    return n >= 6 || p.deck.commanders.some(uses);
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
      if (o.fromGraveyard) score += 1.5; // a land from the graveyard keeps the one in hand for later
      // A land from exile or off the top of the library is an extra card; one playable only this turn goes first.
      if (o.from) score += this.playWindow(g, p, o) === 'turn' ? 6 : 2;
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

  /** How long a card offered from exile stays playable ('turn', 'nextTurn', 'exiled'), 'top' for the top of the library, or null. */
  private playWindow(g: Game, p: PlayerState, a: Action): 'turn' | 'nextTurn' | 'exiled' | 'top' | null {
    if ((a.type !== 'cast' && a.type !== 'land') || !('from' in a) || !a.from) return null;
    if (a.from === 'library') return 'top';
    if (a.from !== 'exile') return null;
    const m = g.exilePlayable(p).find((e) => e.card === a.card);
    return m ? m.until : null;
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
      const normal = casts.some((b) => b.card === a.card && b.from === 'hand' && !b.kick);
      if (a.from === 'alt') {
        // Alternative costs: only when the card can't be cast normally. Cards that cost a card to cast are kept for answers,
        // and evoke is only worth it for what the creature does as it enters.
        const alt = a.card.altCost!;
        // Prowl is its own reward (Notorious Throng's extra turn); emerge only eats a token or something small.
        const always = alt.prowl || (alt.emerge && g.emergeFodder(p, a.card).some((q) => !q.isCommander && (q.token || q.card.value < 2.5)));
        if (alt.pitch || alt.returnIslands || (normal && !always)) continue;
        if ((alt.evoke || alt.warp) && !a.card.effects.some((e) => e.when === 'resolve')) continue;
        // Blitz: a hasty attacker that draws a card when it dies, before combat.
        if (alt.blitz && (g.step !== 'main1' || a.card.power < 2)) continue;
        if (alt.emerge && !always) continue;
      }
      // A suspend or plot card is better used that way than cast at full price early on.
      if (!a.kick && !a.modes && a.from === 'hand' && a.card.casting && this.handFirst(g, a.card)) continue;
      const card = castAs(g, p, a);
      const fromCommand = a.from === 'command';
      const kick = a.kick ? this.kickWorth(g, p, a.card, a.kick, a.maxX) : 0;
      if (kick === null) continue;
      // A kicked instant or sorcery that is much better (Maddening Cacophony mills half a library instead of eight):
      // hold it for the kicker until late in the game.
      if (!a.kick && a.card.kicker && (!a.card.kicker.as || a.card.kicker.as === 'entwine') && !a.card.kicker.multi && !a.card.kicker.offspring && !a.card.kicker.cost.x && (a.card.isInstant || a.card.isSorcery) && g.round < 8) continue;
      // Dread Return's flashback costs three creatures: only for something much better than them.
      if (a.from === 'graveyard' && a.card.casting?.flashbackSac && !this.flashbackSacWorth(g, p, a.card)) continue;
      // Everflowing Chalice: worth nothing without a kick.
      if (!a.kick && a.card.kicker?.charge) continue;
      // Retrace costs a land card from hand: only once there are lands to spare.
      if (a.from === 'graveyard' && a.card.graveyard?.discardLand && !a.card.flashback && g.landCount(p) < 6) continue;
      // Noctis: casting from the graveyard costs life. Only for cards worth it, and not when low.
      if (a.from === 'graveyard' && !a.card.flashback && !a.card.graveyard) {
        const life = g.graveyardPermission(p, a.card)?.life ?? 0;
        if (life > 0 && (p.life - life < 20 || a.card.value < 3)) continue;
      }
      let x = a.maxX;
      if (card.xFromLife) {
        // Pay only as much life as the biggest opposing creature needs, and never go low.
        const need = Math.max(0, ...g.opponents(p).flatMap((o) => o.battlefield.filter((q) => q.card.isCreature).map((q) => g.toughness(q))));
        x = Math.min(x, need);
        if (x <= 0 || p.life - x < 10) continue;
      }
      // Kicker {X} (Thieving Skydiver): X only needs to reach the artifact it takes.
      if (card.cost.x > 0 && x < (card.isCreature ? 2 : 3) && !(a.kick && a.card.kicker?.cost.x)) continue;
      let score = this.castScore(g, p, card, fromCommand, x, instantWindow);
      if (score === null) continue;
      score += kick;
      // Cards played from exile or off the top of the library are extra cards; one that is only playable this turn is now or never.
      const window = this.playWindow(g, p, a);
      if (window === 'turn') score += 25;
      else if (window) score += 4;
      if (a.free) score += 10 + card.cmc;
      // Keep mana up for counterspells and protection unless this play matters.
      if (reserve > 0 && score < 90 && window !== 'turn' && available - g.effectiveCost(p, card, fromCommand, x) < reserve) continue;
      score += card.cmc * 0.1;
      // Mutating builds one bigger threat and sets off every "whenever this creature mutates" in it.
      if (a.mutate) score += 3 + card.effects.filter((e) => e.when === 'mutates').length * 6;
      // Face down only when the card itself is out of reach: it is a plain 2/2 until turned up.
      if (a.faceDown) score -= 10;
      if (score > bestScore) {
        best = { action: a, x };
        bestScore = score;
      }
    }
    return best;
  }

  /** Madness and miracle: cast the card now if it is worth casting at all (the window closes once we pass). */
  private chooseWindow(g: Game, p: PlayerState, casts: CastAction[]): { action: CastAction; x: number } | undefined {
    for (const a of casts) {
      if (a.from !== 'madness' && a.from !== 'miracle') continue;
      const card = castAs(g, p, a);
      const score = this.castScore(g, p, card, false, a.maxX, true);
      if (score !== null && score > 0) return { action: a, x: a.maxX };
    }
    return undefined;
  }

  /**
   * Suspend, plot, foretell, transmute or channel a card from hand. Cards with no mana cost are always suspended;
   * otherwise only with spare mana in the second main phase (or at the end of the turn before ours, for channel).
   */
  private chooseHand(g: Game, p: PlayerState, actions: Action[]): Action | undefined {
    const uses = actions.filter((a): a is HandAction => a.type === 'hand');
    if (!uses.length) return undefined;
    const myMain = g.activeSeat === p.seat && (g.step === 'main1' || g.step === 'main2');
    const lands = g.landCount(p);
    const missing = missingComboPieces(p);
    let best: HandAction | undefined;
    let bestScore = 0;
    for (const a of uses) {
      const c = a.card.casting!;
      let score = 0;
      switch (a.how) {
        case 'suspend': {
          // No mana cost: suspending is the only way to cast it. Otherwise when it is too dear to cast soon and the wait is short.
          const soon = c.suspend!.n <= 4 || !!c.suspend!.onOpponentCast;
          if (c.noCost) score = 10 + a.card.value;
          else if (soon && a.card.cmc > lands + 1) score = 4 + a.card.value - c.suspend!.n * 0.5;
          break;
        }
        case 'plot':
          // Pay now, cast free later: with mana that would go unused this turn.
          if (myMain && g.step === 'main2') score = 3 + a.card.value * 0.5;
          break;
        case 'foretell': {
          // Worth it when the foretold version is cheaper or stronger, with mana left at the end of our turn.
          const later = g.castCard(a.card, 'foretell');
          const cheaper = g.effectiveCost(p, a.card) - g.effectiveCost(p, later);
          if (myMain && g.step === 'main2' && (cheaper > 0 || !!c.foretell!.effects)) score = 2 + cheaper + (c.foretell!.effects ? 3 : 0);
          break;
        }
        case 'transmute': {
          // Find a combo piece, or a much better card of the same mana value.
          const options = p.library.filter((l) => l.cmc === a.card.cmc);
          if (options.some((l) => missing.has(l.name))) score = 20;
          else if (g.round >= 4 && options.some((l) => l.value > a.card.value + 1.5)) score = 3;
          break;
        }
        case 'channel': {
          // A land is channeled only with lands to spare; the effect must be worth the card.
          if (a.card.isLand && lands < 6) break;
          const e = c.channel!.effects;
          if (e.some((f) => f.kind === 'removal')) {
            const f = e.find((x) => x.kind === 'removal')!;
            const t = f.kind === 'removal' ? this.removalTarget(g, p, f, 0, g.targetCandidates(p, f, null) ?? []) : null;
            score = t && t.score >= 4 ? t.score - 1 : 0;
          } else if (e.some((f) => f.kind === 'tokens')) score = g.step === 'main1' || g.activeSeat !== p.seat ? 3 : 0;
          else if (e.some((f) => f.kind === 'draw')) score = a.card.cmc > lands + 2 ? 2 : 0;
          break;
        }
      }
      if (score > bestScore) {
        best = a;
        bestScore = score;
      }
    }
    return best;
  }

  /** A card better suspended, plotted or foretold than cast from hand now. */
  private handFirst(g: Game, card: SimCard): boolean {
    const c = card.casting!;
    if (c.suspend && c.suspend.n <= 2 && card.cmc >= 4) return true;
    if (c.foretell?.effects && g.round < 10) return true;
    return false;
  }

  /** Dread Return: three creatures for one, only when what comes back is worth more than the three of them. */
  private flashbackSacWorth(g: Game, p: PlayerState, card: SimCard): boolean {
    const n = card.casting!.flashbackSac!;
    const fodder = p.battlefield.filter((q) => q.card.isCreature && !q.isCommander).sort((a, b) => threat(g, a) - threat(g, b)).slice(0, n);
    if (fodder.length < n) return false;
    const cost = fodder.reduce((sum, q) => sum + (q.token ? 1 : q.card.value), 0);
    const best = Math.max(0, ...p.graveyard.filter((c) => c.isCreature && c !== card).map((c) => c.value));
    return best > cost + 2;
  }

  /**
   * What paying a spell's kicker (or offspring) `kicks` times adds to casting it, or null when it isn't worth it.
   * Kicked spells are usually strictly better, so the kicked version wins whenever the mana is there.
   */
  private kickWorth(g: Game, p: PlayerState, card: SimCard, kicks: number, maxX: number): number | null {
    const k = card.kicker!;
    switch (k.as) {
      case 'entwine': return 5;
      // Buyback: the card comes back to use again.
      case 'buyback': return 3;
      // Cleave: the wider version is scored on its own.
      case 'cleave': return 0;
      // Bargain and casualty cost a permanent: only a token, a Treasure-like artifact or something small.
      case 'bargain': return p.battlefield.some((q) => (q.card.isArtifact || q.card.isEnchantment || q.token) && !q.isCommander && (q.token || q.card.value < 2) && !q.landInfo) ? 4 : null;
      case 'casualty': return p.battlefield.some((q) => q.card.isCreature && !q.isCommander && g.power(q) >= (k.casualty ?? 1) && (q.token || q.card.value < 3)) ? 6 : null;
      // A gift helps an opponent: worth it for a better spell, never for an extra turn or an 8/8.
      case 'gift': return k.gift === 'extraTurn' || k.gift === 'octopus' ? null : 1.5;
      // Replicate: each copy needs its own use, so only one extra copy per opponent.
      case 'replicate': return kicks < g.opponents(p).length ? kicks * 2 : null;
    }
    if (k.offspring) {
      // A 1/1 copy: worth most when the creature does something as it enters, attacks or dies.
      const triggers = card.effects.filter((e) => e.when !== 'static' && e.when !== 'activated').length;
      return 2 + triggers * 2;
    }
    // Thieving Skydiver: only with an opponent's artifact worth taking within reach.
    const steal = k.effects.find((e) => e.kind === 'steal' && e.what === 'artifact');
    if (steal) {
      const reach = g.opponents(p).flatMap((o) => o.battlefield).filter((q) => q.card.isArtifact && !q.landInfo && q.card.cmc <= maxX && g.canTarget(p, q));
      return reach.some((q) => q.card.value >= 2) ? 6 : null;
    }
    if (k.multi) {
      // Everflowing Chalice: each kick is another mana for good. Comet Storm: another target, when there is one worth hitting.
      if (k.charge) return kicks * 4;
      const removal = card.effects.find((e) => e.kind === 'removal');
      if (removal) {
        const targets = g.opponents(p).length + g.opponents(p).flatMap((o) => o.battlefield).filter((q) => q.card.isCreature && g.toughness(q) <= maxX && threat(g, q) >= 3).length;
        return kicks < targets ? kicks * 3 : null;
      }
      return kicks * 2;
    }
    return 5;
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
    // A Room's door is unlocked as it enters, so "when you unlock this door" happens now (rule 709.5h).
    const kinds = new Set(card.effects.filter((e) => e.when === 'resolve' || e.when === 'static' || (e.when === 'unlock' && !!card.room)).map((e) => e.kind));
    if (fromCommand) return 85 + card.value;
    // Lockouts: only when they hurt the table more than us (Cursed Totem, Dress Down), Silence before a big turn.
    if (!this.lockWorthIt(g, p, card)) return null;
    if (kinds.has('silence') && kinds.size === 1) return 45;

    // Combos and alternative wins: the missing piece goes down as soon as possible.
    if (missingComboPieces(p).has(card.name)) return this.comboReady(p, card) ? 120 : null;
    if (ALT_WIN_NAMES.has(card.name) || card.effects.some((e) => e.kind === 'winOnEmptyDraw')) return 70 + card.value;
    // Don't draw ourselves out of the game.
    const drawsN = card.effects.reduce((n, e) => n + (e.kind === 'draw' && e.when === 'resolve' ? (e.n === -1 ? x : e.n) : 0), 0);
    if (drawsN && drawsN >= p.library.length && !winsOnEmptyDraw(p)) return null;
    if (card.effects.some((e) => e.kind === 'mill' && (e.who === 'you' || e.who === 'all') && e.when === 'resolve') && p.library.length < 20 && !winsOnEmptyDraw(p)) return null;

    // Purely reactive spells wait for something to react to.
    if (!card.isCreature && card.effects.length > 0 && card.effects.every((e) => REACTIVE_KINDS.has(e.kind))) return null;
    if (kinds.has('overrun')) return g.step === 'main1' && this.readyAttackers(g, p).length >= 3 ? 60 : null;

    if (kinds.has('wipe')) {
      const wipe = card.effects.find((e): e is Wipe => e.kind === 'wipe' && (e.when === 'resolve' || e.when === 'unlock'))!;
      return this.wipeIsGood(g, p, wipe, x) ? 95 : null;
    }

    // Land hate: only when it hurts the table more than us, or the deck is built on it.
    if ([...kinds].some((k) => LAND_HATE.has(k))) {
      const worth = this.landHateWorth(g, p, card);
      if (worth === null) return null;
      if (card.isInstant || card.isSorcery) return 40 + worth;
      if (!card.isCreature) return 50 + card.value + worth;
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
    if (regrow && !g.recursionPool(p, regrow).length && !card.isCreature) return null;
    // Grafdigger's Cage and Rest in Peace: worth it against graveyard decks, and not if we are the graveyard deck.
    if ((kinds.has('graveyardLock') || kinds.has('graveyardHate')) && !card.isCreature && this.leansOnGraveyard(p)) return null;
    // Control Magic and lockdown Auras (Amphibian Downpour): worth it on a real threat.
    const stealAura = card.effects.some((e) => e.kind === 'equip' && (e.steal || e.lock));
    if (stealAura) return g.opponents(p).some((o) => o.battlefield.some((q) => q.card.isCreature && g.canTarget(p, q) && threat(g, q) >= 4)) ? 75 : null;
    if (isAura(card) && !p.battlefield.some((q) => q.card.isCreature)) return null;
    if (kinds.has('cheat') && spell && !p.hand.some((c) => c.isCreature)) return null;
    if (kinds.has('exileGraveyards') && spell && kinds.size === 1) return g.opponents(p).some((o) => o.graveyard.length >= 6) ? 15 : null;
    const goad = card.effects.find((e) => e.kind === 'goad' && e.when === 'resolve');
    if (goad && goad.kind === 'goad' && spell) {
      // Goad is worth most when opponents have creatures that will now hit each other.
      const theirs = g.opponents(p).flatMap((o) => o.battlefield.filter((q) => q.card.isCreature));
      const power = goad.all ? theirs.reduce((n, q) => n + g.power(q), 0) : Math.max(0, ...theirs.filter((q) => g.canTarget(p, q)).map((q) => g.power(q)));
      if (power < (goad.all ? 8 : 4) || g.opponents(p).length < 2) return null;
      score = Math.max(score, 45 + power * 0.5);
    }
    const blink = card.effects.find((e) => e.kind === 'blink' && e.when === 'resolve');
    if (blink && blink.kind === 'blink' && spell) {
      const best = Math.max(0, ...p.battlefield.filter((q) => !q.token && !q.landInfo && (blink.what === 'permanent' || q.card.isCreature)).map((q) => etbWorth(q)));
      if (best < 2.5) return null;
      score = Math.max(score, 35 + best);
    }
    // Additional combats: worth it when there is enough power to swing again.
    const extra = card.effects.find((e): e is Extract<Effect, { kind: 'extraCombat' }> => e.kind === 'extraCombat' && e.when === 'resolve');
    if (extra && spell) {
      if (g.activeSeat !== p.seat || extra.inCombat) return null;
      const untapsNow = card.effects.find((e) => e.kind === 'untap' && e.when === 'resolve');
      // Untapping before anyone attacked is wasted: Relentless Assault waits for the second main phase.
      if (g.step === 'main1' && untapsNow && !extra.untapAttacked) return null;
      const ready = this.readyAttackers(g, p);
      const attacked = p.battlefield.filter((q) => q.card.isCreature && q.tapped && q.attackedTurn === g.turnNumber && !q.stun);
      const back = untapsNow?.kind === 'untap' && untapsNow.what === 'permanent' ? attacked.sort((a, b) => g.power(b) - g.power(a)).slice(0, untapsNow.n) : untapsNow || extra.untapAttacked ? attacked : [];
      const power = [...ready, ...back].reduce((n, q) => n + g.power(q), 0) * Math.max(1, extra.n);
      return power >= 4 ? 50 + power : null;
    }
    // Mind Games: tap a blocker before our attack, or an attacker at an opponent's beginning of combat.
    if (spell && kinds.has('tap') && !removal) return this.tapWorthNow(g, p) ? 25 + card.value : null;
    const untap = card.effects.find((e) => e.kind === 'untap' && e.when === 'resolve');
    if (untap && untap.kind === 'untap' && spell) {
      // Dramatic Reversal and friends: worth it when they give back more mana than they cost.
      const back = p.battlefield.filter((q) => q.tapped && (untap.what === 'lands' ? !!q.landInfo : untap.what === 'nonland' || untap.what === 'artifacts' ? !q.landInfo && q.card.effects.some((e) => e.kind === 'mana') : !!q.landInfo)).length;
      if (Math.min(back, untap.n) <= card.cmc) return null;
      score = Math.max(score, 30);
    }
    if (kinds.has('extraTurn') || kinds.has('approach') || kinds.has('steal') || kinds.has('cheat')) score = Math.max(score, 55 + card.value);
    if (spell && kinds.has('counters') && !p.battlefield.some((q) => q.card.isCreature)) return null;

    if (!spell) score = Math.max(score, 50 + card.value);
    if (kinds.has('draw')) score = Math.max(score, 45 + card.value);
    if (kinds.has('mill') || kinds.has('discard') || kinds.has('scry')) score = Math.max(score, 25 + card.value);
    // A deck built to mill people out plays its mill cards like threats, and more urgently as libraries run low.
    if (kinds.has('mill') && (this.plan?.mill ?? 0) >= 6) {
      const thinnest = Math.min(...g.opponents(p).map((o) => o.library.length));
      score = Math.max(score, 45 + card.value + (thinnest < 30 ? 15 : 0));
    }
    if (kinds.has('artifactToken')) score = Math.max(score, 30 + card.value);
    if (kinds.has('tutor') || kinds.has('recursion') || kinds.has('tokens') || kinds.has('drain') || kinds.has('damagePlayer') || kinds.has('counters')) {
      score = Math.max(score, 40 + card.value);
    }
    // Reanimation: as good as the best thing it brings back (all of them, for mass returns).
    if (regrow?.toBattlefield && spell) {
      const pool = g.recursionPool(p, regrow).map((c) => c.card.value + c.card.cmc * 0.5).sort((a, b) => b - a);
      const got = regrow.all ? pool.reduce((a, b) => a + b, 0) : pool.slice(0, regrow.n).reduce((a, b) => a + b, 0);
      if (got < 3) return null;
      score = Math.max(score, 50 + got);
    }
    // Entomb: set up a reanimation spell in hand, or graveyard-casting cards.
    if (kinds.has('entomb') && spell) {
      const reanimate = p.hand.some((c) => c !== card && c.effects.some((e) => e.kind === 'recursion' && e.toBattlefield));
      score = reanimate ? Math.max(score, 60) : this.leansOnGraveyard(p) ? Math.max(score, 35) : Math.max(score, 20);
    }
    // Burn and drain decks: the engines that drain on every death or spell are the plan, not an extra.
    if ((this.plan?.drain ?? 0) >= 8 && card.effects.some((e) => (e.kind === 'drain' || e.kind === 'damagePlayer') && e.when !== 'resolve')) score = Math.max(score, 55 + card.value);
    if (kinds.has('gainLife')) score = Math.max(score, 10);
    if (!card.modeled) {
      if (spell) return null;
      score = Math.max(score, 1);
    }
    // Instants in our own main phase: only if nothing better. They usually wait for the end-of-turn window.
    if (card.isInstant && !instantWindow && !card.effects.some((e) => e.kind === 'ramp')) score = Math.min(score, 20);
    return score || null;
  }

  /**
   * Whether to put a combo piece down now. Isochron Scepter waits until
   * Dramatic Reversal is in hand to go under it (it is exiled as it enters).
   */
  /** A Pact can be cast if its cost can be paid next upkeep: enough lands and mana rocks, of the right colors. */
  private pactPayable(g: Game, p: PlayerState, card: SimCard): boolean {
    const pact = card.effects.find((e) => e.kind === 'pact');
    if (!pact || pact.kind !== 'pact') return true;
    const sources = g.landCount(p) + p.battlefield.filter((q) => !q.landInfo && q.card.effects.some((e) => e.kind === 'mana')).length;
    const colors = g.colorsAvailable(p);
    return sources >= pact.cost.generic + pact.cost.pips.length + 1 && pact.cost.pips.every((pip) => pip.some((c) => colors.has(c)));
  }

  /**
   * Symmetric lockouts hurt us too. Cursed Totem only if opponents lose more creature abilities than we do, Dress Down
   * only if their creatures have more abilities, Silence only on our own turn with a big attack or a win to protect.
   */
  private lockWorthIt(g: Game, p: PlayerState, card: SimCard): boolean {
    for (const e of card.effects) {
      if (e.when !== 'static' && e.when !== 'resolve') continue;
      if (e.kind === 'abilityLock' && e.who === 'all') {
        const users = (q: PlayerState) => q.battlefield.filter((x) => (e.perms === 'creatures' ? x.card.isCreature : x.card.isArtifact) && x.card.effects.some((f) => f.when === 'activated' || f.kind === 'mana')).length;
        const ours = users(p) + p.hand.filter((c) => (e.perms === 'creatures' ? c.isCreature : c.isArtifact) && c.effects.some((f) => f.when === 'activated' || f.kind === 'mana')).length;
        if (ours >= Math.max(...g.opponents(p).map(users), 1)) return false;
      }
      if (e.kind === 'loseAbilities' && e.what === 'creatures') {
        const worth = (q: PlayerState) => q.battlefield.filter((x) => x.card.isCreature).reduce((n, x) => n + x.card.effects.length + x.card.keywords.length, 0);
        if (worth(p) >= Math.max(...g.opponents(p).map(worth), 1)) return false;
      }
      if (e.kind === 'silence') {
        if (g.activeSeat !== p.seat || g.step !== 'main1') return false;
        const power = this.readyAttackers(g, p).reduce((n, q) => n + g.power(q), 0);
        if (power < 8 && !p.hand.some((c) => c !== card && (WINCON_NAMES.has(c.name) || c.effects.some((f) => f.kind === 'winIf' || f.kind === 'extraTurn')))) return false;
      }
    }
    return true;
  }

  private comboReady(p: PlayerState, card: SimCard): boolean {
    if (card.name !== 'Isochron Scepter') return true;
    return p.hand.some((c) => c.name === 'Dramatic Reversal');
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
        if (e.kind === 'recursion') return g.recursionPool(p, e).length > 0;
        // Tezzeret's -5: a big attack before combat. Vraska's -2: a creature worth removing.
        if (e.kind === 'becomeCreature') return e.what !== 'artifacts' || (g.step === 'main1' && g.activeSeat === p.seat && p.battlefield.filter((q) => q.card.isArtifact && !q.card.isCreature && !q.landInfo).length >= 3);
        if (e.kind === 'becomeTreasure') return g.opponents(p).some((o) => o.battlefield.some((q) => q.card.isCreature && g.canTarget(p, q) && threat(g, q) >= 4));
        // Jace's -8: draw the rest of the library and win.
        if (e.kind === 'draw') return e.n < p.library.length || winsOnEmptyDraw(p);
        // Tezzeret the Seeker's -X: only with an artifact in reach.
        if (e.kind === 'tutor' && e.artifactToBattlefield) return p.library.some((c) => c.isArtifact && !c.isLand && c.cmc <= (g.findPerm(a.permId)?.loyalty ?? 0) && c.value >= 2);
        if (e.kind === 'sacrificeHalf') return g.opponents(p).some((o) => o.battlefield.filter((q) => !q.landInfo && !q.emblem).length >= 3);
        if (e.kind === 'poison') return g.opponents(p).some((o) => o.poison < 9);
        return e.kind !== 'gainLife' && e.kind !== 'scry';
      };
      const minus = loyal.filter((a) => (a.effect.loyalty ?? 0) < 0 && worth(a)).sort((x, y) => (x.effect.loyalty ?? 0) - (y.effect.loyalty ?? 0))[0];
      const plus = loyal.filter((a) => (a.effect.loyalty ?? 0) >= 0 && !a.effect.loyaltyX).sort((x, y) => (y.effect.loyalty ?? 0) - (x.effect.loyalty ?? 0))[0];
      const perm = minus ? g.findPerm(minus.permId) : null;
      // Keep at least one loyalty unless the ability is removal that matters.
      const winsNow = !!minus && minus.effect.kind === 'draw' && minus.effect.n >= p.library.length && winsOnEmptyDraw(p);
      // Ultimates (emblems, extra turns, the big minus abilities) are worth the planeswalker.
      const ultimate = !!minus && ((minus.effect.loyalty ?? 0) <= -6 || ['emblem', 'extraTurn', 'sacrificeHalf', 'digPermanent'].includes(minus.effect.kind));
      if (minus && perm && ((perm.loyalty ?? 0) + (minus.effect.loyalty ?? 0) >= 1 || minus.effect.kind === 'removal' || minus.effect.kind === 'wipe' || winsNow || ultimate)) return minus;
      // "-X": worth it once X reaches something worth having.
      const xAbility = loyal.find((a) => a.effect.loyaltyX && this.loyaltyX(g, p, a) > 0);
      if (xAbility && (g.findPerm(xAbility.permId)?.loyalty ?? 0) >= 4) return xAbility;
      if (plus) return plus;
    }
    // Abilities that spend energy or charge counters come before the ones that make them.
    const spends = (a: Action) => (a.type === 'activate' && (a.effect.activation?.energy || a.effect.activation?.charge) ? 0 : 1);
    return [...actions].sort((a, b) => spends(a) - spends(b)).find((a) => {
      if (a.type !== 'activate' || a.effect.kind === 'equip') return false;
      const perm = g.findPerm(a.permId);
      // Ygra's Food: our own small creatures and tokens become counters on Ygra and life, at the end of the turn before ours.
      if (a.effect === FOOD) {
        if (!perm || perm.isCommander || (!perm.token && perm.card.value >= 2.5) || g.activeSeat === p.seat) return false;
        return p.battlefield.some((q) => q.card.effects.some((e) => e.kind === 'foodCreatures')) && p.battlefield.filter((q) => q.card.isCreature).length > 2;
      }
      if (!perm || (!a.effect.activation?.tap && perm.activations >= 3)) return false;
      const e = a.effect;
      // Paying life: only while comfortably healthy.
      if ((e.activation?.cost.life ?? 0) > 0 && p.life < 20) return false;
      if (e.activation?.sacCreature) {
        // Sacrifice outlets: only feed them tokens and small creatures, and only for something worth having.
        // With death triggers that drain the table, every token is worth feeding in.
        const drains = deathDrain(p) > 0;
        if (e.kind === 'treasure' && !drains) return false;
        const fodder = p.battlefield.filter((q) => q.card.isCreature && q !== perm && !q.isCommander && (q.token || q.card.value < 2.5));
        if (!fodder.length || (perm.activations >= 2 && !(drains && fodder.some((q) => q.token)))) return false;
      }
      // "Pay X {E}": only with a few energy saved up.
      if (e.activation?.energy === -1 && p.energy < 3) return false;
      // Discarding as a cost: only from a full hand, or with lands to spare.
      if (e.activation?.discard && p.hand.length < 4 && !(p.hand.filter((c) => c.isLand).length >= 2 && g.landCount(p) >= 5)) return false;
      // Removing counters from our other permanents: only with some to spare.
      if (e.activation?.removeCounters?.from === 'any' && g.counterPool(p, perm, 'any') < e.activation.removeCounters.n + 2) return false;
      switch (e.kind) {
        case 'draw': return p.library.length > 8 || winsOnEmptyDraw(p);
        case 'energy': case 'digPermanent': case 'extraTurn': return true;
        case 'wipe': return this.wipeIsGood(g, p, e, 0);
        // Charge counters: only on something that pays them off in reach (not Fire Nation Turret's fifty).
        case 'charge': return e.target ? p.battlefield.some((q) => q !== perm && q.card.isArtifact && chargeUse(q.card) > 0) : chargeUse(perm.card) > 0;
        case 'rollDice': return true;
        // Sigurd's boast: a lore counter is a Saga chapter now and a +1/+1 counter.
        case 'lore': return true;
        // Zur: before combat, an enchantment worth at least a 3/3 body.
        case 'animate': return g.step === 'main1' && g.activeSeat === p.seat && (g.targetCandidates(p, e, perm) ?? []).some((t) => t.kind === 'perm' && (g.findPerm(t.id)?.card.cmc ?? 0) >= 3);
        // Destiny Spinner, Katsumasa, Peacewalker Colossus, Bespoke Battlewagon: an extra attacker before combat.
        case 'becomeCreature': {
          if (g.step !== 'main1' || g.activeSeat !== p.seat || perm.card.isCreature && e.what === 'self') return false;
          if (e.what === 'land' && p.battlefield.filter((q) => q.card.isEnchantment).length < 3) return false;
          const aims = g.targetCandidates(p, e, perm);
          return aims === null || aims.length > 0;
        }
        case 'gainLife': return p.life < 30 && g.activeSeat !== p.seat;
        // Tinybones: only when someone has an empty hand.
        case 'drain': return !e.emptyHand || g.opponents(p).some((o) => o.hand.length === 0);
        // "Creatures you control gain haste": before combat, with fresh creatures worth sending in.
        case 'overrun': return !e.p && !!e.grant?.includes('haste') && g.step === 'main1' && g.activeSeat === p.seat && p.battlefield.some((q) => q.card.isCreature && q.sick && !q.tapped && g.power(q) >= 2 && !g.hasKw(q, 'haste'));
        case 'tokens': case 'counters': case 'drain': case 'damagePlayer': case 'ramp': case 'tutor': case 'treasure': case 'discard': case 'scry': return true;
        // Impulse draw that has to be played this turn: only in our own main phase with mana left to play it.
        case 'exilePlay': return e.until !== 'turn' || (g.activeSeat === p.seat && g.step === 'main2' && g.availableMana(p) >= 3);
        case 'freeCast': case 'search': return true;
        // Sensei's Divining Top: with mana that would otherwise go unused, before our own turn.
        case 'rearrange': return g.activeSeat !== p.seat;
        // Milling everyone (Syr Konrad) only while we have more cards left than the table, or win on an empty library.
        case 'mill': return e.who === 'all' ? winsOnEmptyDraw(p) || p.library.length > Math.min(...g.opponents(p).map((o) => o.library.length)) + 10 : e.who !== 'you' || winsOnEmptyDraw(p);
        // "Can't be blocked this turn": before combat, with something worth sending in.
        case 'pump':
          if (e.self) return this.selfPumpNow(g, p, perm, e);
          return !!e.grant?.includes('unblockable') && g.step === 'main1' && g.activeSeat === p.seat && p.battlefield.some((q) => q.card.isCreature && !q.tapped && !q.sick && g.power(q) >= 3);
        case 'removal': {
          const t = this.removalTarget(g, p, e, 0, g.targetCandidates(p, e, perm) ?? []);
          return !!t && t.score >= 3 + g.round * 0.2;
        }
        case 'recursion': return !e.toTop && g.recursionPool(p, e).length > 0;
        case 'exileGraveyards': return e.cards ? g.opponents(p).some((o) => o.graveyard.some((c) => c.value >= 5)) : g.opponents(p).some((o) => o.graveyard.length >= 8);
        case 'entomb': return true;
        case 'stun': case 'bounty': case 'poison': return true;
        case 'tap': return this.tapWorthNow(g, p);
        case 'kwCounter': return e.on !== 'self' || !perm.kwCounters?.includes(e.kw);
        // Midnight Clock: wind it forward when a fresh hand of seven beats what we hold, and not if the graveyard is our engine.
        case 'hours': return p.hand.length <= 2 && !this.leansOnGraveyard(p) && (perm.hours ?? 0) >= 6;
        case 'millReanimate': return p.library.length > 10;
        case 'cheat': return p.hand.some((c) => c.isCreature);
        case 'goad': return e.all || g.opponents(p).length >= 2;
        case 'blink': return p.battlefield.some((q) => q !== perm && !q.token && (e.what === 'permanent' || q.card.isCreature) && etbWorth(q) >= 2.5);
        // Transform when the other face is the better card. An Incubator hatches into a creature as big as its counters.
        case 'transform': return isIncubator(perm.card) ? perm.counters >= 1 : !!perm.card.back && perm.card.back.value >= perm.card.value * 0.8;
        case 'hatch': return p.battlefield.some((q) => isIncubator(q.card) && q.counters >= 1);
        case 'artifactToken': return true;
        // Hideaway lands: play the hidden card once the condition holds.
        case 'playHidden': return !!perm.hidden && g.hiddenPlayable(p, e);
        // Teferi's +1 (flash for sorceries until our next turn); a land sacrificed for flash isn't worth it.
        case 'flashGrant': return e.when === 'loyalty';
        // Jace Reawakened: plot a cheap card to cast free later.
        case 'plotFromHand': return p.hand.some((c) => !c.isLand && c.cmc <= e.maxCmc && c.cmc >= 2);
        // Kiki-Jiki and friends: a copy before combat (it has haste) or at the end of an opponent's turn.
        case 'tokenCopy': {
          if (e.of !== 'target') return true;
          const pool = (g.targetCandidates(p, e, perm) ?? []).flatMap((t) => (t.kind === 'perm' ? [g.findPerm(t.id)] : [])).filter((q): q is Perm => !!q && !(q.card.isLegendary && q.seat === p.seat && !e.nonlegendary));
          const worth = Math.max(0, ...pool.map((q) => threat(g, q) + etbWorth(q)));
          return worth >= 3 && (e.haste || e.end ? g.step === 'main1' && g.activeSeat === p.seat : true);
        }
        // Becoming a copy of something clearly better than what it is now.
        case 'becomeCopy':
          return (g.targetCandidates(p, e, perm) ?? []).some((t) => t.kind === 'perm' && t.id !== perm.id && threat(g, g.findPerm(t.id)!) >= threat(g, perm) + 2);
        // Taking something: worth it when there's something to take, and a temporary steal only before combat.
        case 'steal':
          if (e.until && !(g.step === 'main1' && g.activeSeat === p.seat)) return false;
          return e.from !== 'battlefield' || (g.targetCandidates(p, e, perm) ?? []).length > 0;
        case 'copyNext': return g.activeSeat === p.seat && g.step === 'main1' && p.hand.some((c) => c.isInstant || c.isSorcery);
        default: return false;
      }
    });
  }

  /**
   * Abilities that shape a combat (rules 508.1c-d, 509.1b): on an opponent's turn, "creatures your opponents control attack
   * this turn if able" when they'd mostly be sent into each other or into our blockers, or "target creature can't attack"
   * on their biggest attacker; on our turn, "can't block" on the blocker in our way.
   */
  private chooseCombatShaping(g: Game, p: PlayerState, actions: Action[]): Action | undefined {
    const myTurn = g.activeSeat === p.seat;
    const active = g.players[g.activeSeat];
    for (const a of actions) {
      if (a.type !== 'activate') continue;
      const e = a.effect;
      if (e.kind === 'forceAttack' && !myTurn) {
        const ready = g.attackCandidates(active).filter((q) => !g.mustAttack(q));
        if (!ready.length) continue;
        // More opponents than just us to hit, or nothing that threatens our life.
        const power = ready.reduce((n, q) => n + hitDamage(g, q), 0);
        if (g.opponents(active).length >= 2 || power * 2 < p.life) return a;
      }
      if (e.kind === 'pacify') {
        if (!myTurn && e.attack) {
          const big = active.battlefield.filter((q) => q.card.isCreature && !q.tapped && !q.sick && g.power(q) >= 4);
          if (big.length) return a;
        }
        if (myTurn && e.block && g.step === 'main1') {
          const mine = g.attackCandidates(p).filter((q) => g.power(q) >= 2);
          const walls = g.opponents(p).flatMap((o) => o.battlefield).filter((q) => q.card.isCreature && !q.tapped && g.toughness(q) >= 3);
          if (mine.length && walls.length) return a;
        }
      }
    }
    return undefined;
  }

  /** Mother of Runes in a fight: protection from the color of what would kill one of our creatures (it then deals no damage to it). */
  private combatProtect(g: Game, p: PlayerState, actions: Action[]): Action | undefined {
    const shield = actions.find((a) => a.type === 'activate' && a.effect.kind === 'protectColor');
    if (!shield) return undefined;
    const doomed = p.battlefield.some((q) => {
      const foes = q.attacking !== null ? g.blockersOf(q) : q.blocking !== null ? [g.findPerm(q.blocking)].filter((f): f is Perm => !!f) : [];
      return foes.length > 0 && foes.some((f) => cardColors(f.card).length > 0) && foes.reduce((n, f) => n + g.power(f), 0) >= g.toughness(q) - q.damage && threat(g, q) >= 3;
    });
    return doomed ? shield : undefined;
  }

  /**
   * Is tapping an opponent's creature useful right now? Before our attack (main phase or beginning of combat) when it
   * would remove a blocker, or at an opponent's beginning of combat when they have a creature worth stopping.
   */
  private tapWorthNow(g: Game, p: PlayerState): boolean {
    if (g.activeSeat === p.seat) {
      if (g.step !== 'main1' && g.step !== 'beginCombat') return false;
      if (!this.readyAttackers(g, p).length) return false;
      return g.opponents(p).some((o) => o.battlefield.some((q) => q.card.isCreature && !q.tapped && g.canTarget(p, q)));
    }
    if (g.step !== 'beginCombat') return false;
    const active = g.players[g.activeSeat];
    return active.battlefield.some((q) => q.card.isCreature && !q.tapped && !q.sick && g.power(q) >= 3 && g.canTarget(p, q));
  }

  /** Which opponent's permanent to tap: their best blocker on our turn, the active player's biggest attacker on theirs. */
  private tapTarget(g: Game, p: PlayerState, perms: Perm[]): Perm | null {
    const theirs = perms.filter((q) => q.seat !== p.seat && !q.tapped);
    const creatures = theirs.filter((q) => q.card.isCreature);
    const pool = g.activeSeat === p.seat ? creatures : creatures.filter((q) => q.seat === g.activeSeat && !q.sick);
    const list = pool.length ? pool : creatures.length ? creatures : theirs;
    if (!list.length) return null;
    // Our turn: the blocker that stops the most (toughness, then threat). Theirs: the attacker that hurts most.
    const score = (q: Perm) => (g.activeSeat === p.seat ? g.toughness(q) + threat(g, q) * 0.3 : g.power(q) + threat(g, q) * 0.3) + (q.card.isCreature ? 5 : q.card.effects.some((e) => e.kind === 'mana') ? 1 : 0);
    return list.reduce((a, b) => (score(b) > score(a) ? b : a));
  }

  /** "~ gains haste / indestructible until end of turn": when that changes something. */
  private selfPumpNow(g: Game, p: PlayerState, perm: Perm, e: Pump): boolean {
    if (!perm.card.isCreature) return false;
    const grant = e.grant ?? [];
    if (grant.some((k) => perm.tempKw.includes(k))) return false;
    // Haste: in the first main phase, so a summoning-sick creature can attack.
    if (grant.includes('haste')) return perm.sick && !perm.tapped && g.step === 'main1' && g.activeSeat === p.seat && !g.hasKw(perm, 'haste');
    // Indestructible / regenerate: when removal is aimed at it, or it is about to die in combat.
    if (grant.includes('indestructible') || grant.includes('regenerate') || e.protect) {
      if (this.threatened(g, p, [perm])) return true;
      if (g.step !== 'declareBlockers') return false;
      const foes = perm.attacking !== null ? g.blockersOf(perm) : perm.blocking !== null ? [g.findPerm(perm.blocking)].filter((q): q is Perm => !!q) : [];
      return foes.reduce((n, q) => n + g.power(q), 0) >= g.toughness(perm) - perm.damage || foes.some((q) => g.hasKw(q, 'deathtouch'));
    }
    if (grant.includes('unblockable')) return g.step === 'main1' && g.activeSeat === p.seat && !perm.tapped && !perm.sick;
    // Firebreathing-style +N/+0: an unblocked attacker with mana to spare.
    if (e.p > 0) return g.step === 'declareBlockers' && perm.attacking !== null && !perm.blocked;
    return false;
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

    // Curses: the opponent it hurts most.
    if ((e === null && d.card.curse) || e?.kind === 'passCurse') {
      const seat = this.curseVictim(g, p, d.card, d.candidates.flatMap((t) => (t.kind === 'player' ? [t.seat] : [])));
      return seat === null ? d.candidates[0] : { kind: 'player', seat };
    }
    // Aura spells and Equipment: our best creature.
    if (e === null && d.card.effects.some((f) => f.kind === 'equip' && (f.steal || f.lock))) {
      const theirs = perms.filter((q) => q.seat !== p.seat);
      return asTarget(bestOf(theirs.length ? theirs : perms, (q) => threat(g, q))) ?? d.candidates[0];
    }
    if (e === null || e.kind === 'equip') {
      const pool = mine.length ? mine : perms;
      return asTarget(bestOf(pool, (q) => g.power(q) + (q.isCommander ? 2 : 0) - (q.sick ? 1 : 0))) ?? d.candidates[0];
    }
    switch (e.kind) {
      case 'fog':
        // The attacker that would hurt us most.
        return asTarget(bestOf(perms, (q) => (q.attacking === p.seat ? 10 : 0) + (q.blocked ? 0 : 5) + g.power(q))) ?? d.candidates[0];
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
      case 'protectColor':
        return asTarget(this.threatened(g, p, mine)) ?? asTarget(bestOf(mine, (q) => threat(g, q) + (q.attacking !== null || q.blocking !== null ? 3 : 0))) ?? d.candidates[0];
      case 'suspect':
        // An opponent's best blocker: it can't block any more, and gets goaded with Nelly Borca.
        return asTarget(bestOf(perms.filter((q) => q.seat !== p.seat), (q) => g.power(q) + g.toughness(q) + (q.tapped ? -3 : 0))) ?? d.candidates[0];
      case 'pacify': {
        // On our turn, the blocker that stands in our way; on theirs, the attacker that would hit us hardest.
        const theirs = perms.filter((q) => q.seat !== p.seat);
        if (g.activeSeat === p.seat) return asTarget(bestOf(theirs.filter((q) => !q.tapped), (q) => g.toughness(q) + g.power(q))) ?? d.candidates[0];
        return asTarget(bestOf(theirs.filter((q) => q.seat === g.activeSeat), (q) => g.power(q) + (q.tapped ? -10 : 0))) ?? d.candidates[0];
      }
      case 'goad': {
        // The opponent's biggest creature, best of all one whose controller has plenty of other opponents to hit.
        return asTarget(bestOf(perms.filter((q) => q.seat !== p.seat), (q) => g.power(q) + (g.hasKw(q, 'flying') ? 1 : 0))) ?? d.candidates[0];
      }
      case 'blink': {
        const saved = this.threatened(g, p, mine);
        if (saved) return asTarget(saved);
        const best = bestOf(mine, (q) => this.blinkWorth(g, p, q));
        // An optional blink trigger with nothing worth blinking: decline.
        if (d.cancellable && !g.stack.some((s) => s.controller === p.seat && s.kind === 'spell' && s.card === d.card) && (!best || this.blinkWorth(g, p, best) < 0)) return null;
        return asTarget(best) ?? d.candidates[0];
      }
      case 'copySpell': {
        const items = d.candidates.flatMap((t) => (t.kind === 'stack' ? g.stack.filter((s) => s.id === t.id) : []));
        const top = items.reduce<StackItem | null>((a, b) => (!a || stackWorth(b) > stackWorth(a) ? b : a), null);
        return top ? { kind: 'stack', id: top.id } : d.candidates[0];
      }
      case 'redirect': {
        // The opponent's spell that hurts us most; nothing to save, nothing to change.
        const items = d.candidates.flatMap((t) => (t.kind === 'stack' ? g.stack.filter((s) => s.id === t.id) : []));
        const worst = items.reduce<StackItem | null>((a, b) => (!a || this.harm(g, p, b) > this.harm(g, p, a) ? b : a), null);
        if (worst && this.harm(g, p, worst) > 0) return { kind: 'stack', id: worst.id };
        return d.cancellable ? null : d.candidates[0];
      }
      case 'tokenCopy':
      case 'becomeCopy': {
        // The best body to copy, but not a legend we control (the copy would die to the legend rule).
        const legal = (q: Perm) => !(q.card.isLegendary && q.seat === p.seat && !(e.kind === 'tokenCopy' && e.nonlegendary));
        const best = bestOf(perms, (q) => threat(g, q) + etbWorth(q) - (legal(q) ? 0 : 100));
        // Gogo, Protean Thaumaturge: "you may" become a copy, so not of something worse than what it is now.
        const self = e.kind === 'becomeCopy' ? p.battlefield.find((q) => q.card === d.card) : undefined;
        if (d.cancellable && self && (!best || threat(g, best) <= threat(g, self))) return null;
        return asTarget(best) ?? d.candidates[0];
      }
      case 'steal': {
        // Threaten: the biggest attacker it can send in now.
        if (e.from === 'battlefield' && e.until) return asTarget(bestOf(perms, (q) => g.power(q) + (g.hasKw(q, 'flying') ? 1 : 0) - (q.tapped && !e.untap ? 10 : 0))) ?? d.candidates[0];
        if (e.from === 'battlefield') return asTarget(bestOf(perms, (q) => threat(g, q) + (e.what === 'artifact' ? q.card.value : 0))) ?? d.candidates[0];
        // The library with the best creature in it.
        const seats = d.candidates.flatMap((t) => (t.kind === 'player' ? [t.seat] : []));
        const best = (seat: number) => Math.max(0, ...g.players[seat].library.filter((c) => c.isCreature).map((c) => c.value));
        return seats.length ? { kind: 'player', seat: seats.reduce((a, b) => (best(b) > best(a) ? b : a)) } : d.candidates[0];
      }
      case 'mill':
      case 'discard': {
        // Whoever is closest to running out, or holds the most cards.
        // With Laboratory Maniac out, our own library is the one to empty when it is the shortest.
        if (e.kind === 'mill' && winsOnEmptyDraw(p) && d.candidates.some((t) => t.kind === 'player' && t.seat === p.seat)
          && g.opponents(p).every((o) => o.library.length > p.library.length)) return { kind: 'player', seat: p.seat };
        const seats = d.candidates.flatMap((t) => (t.kind === 'player' && t.seat !== p.seat ? [t.seat] : []));
        if (!seats.length) return d.candidates[0];
        const score = (seat: number) => (e.kind === 'mill' ? -g.players[seat].library.length : g.players[seat].hand.length);
        return { kind: 'player', seat: seats.reduce((a, c) => (score(c) > score(a) ? c : a)) };
      }
      case 'tap':
        return asTarget(this.tapTarget(g, p, perms)) ?? d.candidates[0];
      case 'stun':
      case 'bounty':
        return asTarget(bestOf(perms.filter((q) => q.seat !== p.seat), (q) => threat(g, q) - (e.kind === 'stun' && q.tapped ? 0 : 1))) ?? d.candidates[0];
      case 'monarch': {
        // Garland: hand the crown to the opponent with the best creature to take.
        const seats = d.candidates.flatMap((t) => (t.kind === 'player' ? [t.seat] : []));
        const best = (seat: number) => Math.max(0, ...g.players[seat].battlefield.filter((q) => q.card.isCreature).map((q) => threat(g, q)));
        return seats.length ? { kind: 'player', seat: seats.reduce((a, b) => (best(b) > best(a) ? b : a)) } : d.candidates[0];
      }
      case 'poison': {
        // The opponent closest to ten poison counters.
        const seats = d.candidates.flatMap((t) => (t.kind === 'player' && t.seat !== p.seat ? [t.seat] : []));
        return seats.length ? { kind: 'player', seat: seats.reduce((a, b) => (g.players[b].poison > g.players[a].poison ? b : a)) } : d.candidates[0];
      }
      case 'kwCounter':
        return asTarget(bestOf(mine, (q) => threat(g, q))) ?? d.candidates[0];
      case 'lore':
        // The Saga closest to its last chapter, so its best chapter comes sooner.
        return asTarget(bestOf(perms, (q) => q.lore ?? 0)) ?? d.candidates[0];
      case 'blight': {
        // Ultima: cut off an opponent's colors, best of all a land that taps for several. Our own lands only if nothing else.
        const theirs = perms.filter((q) => q.seat !== p.seat);
        const colors = (q: Perm) => (q.landInfo?.produces === 'any' ? 5 : (q.landInfo?.produces ?? []).filter((m) => m !== 'C').length);
        const pool = theirs.length ? theirs : perms;
        return asTarget(bestOf(pool, (q) => colors(q) * 2 + (q.card.isBasic ? 0 : 1) + (q.unlocked && !q.unlocked.isBasic ? 1 : 0) - (q.seat === p.seat ? 10 : 0))) ?? d.candidates[0];
      }
      case 'becomeCreature':
        // The biggest artifact or Vehicle, or an untapped land.
        return asTarget(bestOf(mine, (q) => (e.what === 'land' ? (q.tapped ? 0 : 1) : q.card.cmc + q.card.power))) ?? d.candidates[0];
      case 'blank':
      case 'slime':
      case 'becomeTreasure': {
        const theirs = perms.filter((q) => q.seat !== p.seat);
        return asTarget(bestOf(theirs, (q) => threat(g, q))) ?? asTarget(bestOf(perms, (q) => -threat(g, q))) ?? d.candidates[0];
      }
      case 'becomeArtifact':
        return asTarget(mine[0]) ?? d.candidates[0];
      case 'animate':
        // Zur: the biggest enchantment we have.
        return asTarget(bestOf(mine, (q) => q.card.cmc)) ?? d.candidates[0];
      case 'damagePlayer': {
        const amount = e.n === -1 ? 3 : e.n;
        const seat = this.playerToBurn(g, p, d.candidates.flatMap((t) => (t.kind === 'player' ? [t.seat] : [])), amount);
        return seat === null ? d.candidates[0] : { kind: 'player', seat };
      }
      default:
        return d.candidates[0];
    }
  }

  /**
   * Who to curse. Curses that reward attacking go on the opponent the table attacks most (the weakest board);
   * the rest on the leader (the biggest board and life total).
   */
  private curseVictim(g: Game, p: PlayerState, card: SimCard, seats: number[]): number | null {
    const opps = seats.map((s) => g.players[s]).filter((o) => o.alive && o !== p);
    if (!opps.length) return null;
    const onAttack = (card.curse ?? []).some((c) => c.on === 'attacked' || c.act === 'hospitality');
    const already = (o: PlayerState) => g.cursesOn(o).filter((q) => q.card.name === card.name).length;
    const score = (o: PlayerState) => (onAttack ? -boardThreat(g, o, true) : boardThreat(g, o) * 0.5 + o.life * 0.3) - already(o) * 5;
    return opps.reduce((a, b) => (score(b) > score(a) ? b : a)).seat;
  }

  /** Blinking `perm` now: its enters abilities, less the attack it loses to summoning sickness before our combat. */
  private blinkWorth(g: Game, p: PlayerState, perm: Perm): number {
    let v = etbWorth(perm);
    const beforeCombat = g.activeSeat === p.seat && ['untap', 'upkeep', 'draw', 'main1', 'beginCombat'].includes(g.step);
    if (beforeCombat && perm.card.isCreature && !perm.sick && !g.hasKw(perm, 'haste') && g.power(perm) > 0) v -= 2 + g.power(perm) * 0.5;
    // A tapped mana rock comes back untapped.
    if (perm.tapped && perm.card.effects.some((e) => e.kind === 'mana')) v += 1;
    return v;
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
    // Otherwise chip at whoever is closest to dying (to finish them), weighed against who is most dangerous.
    const score = (o: PlayerState) => boardThreat(g, o) * 0.3 - o.life * 0.5;
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

    // Permanents our own spells and abilities on the stack already aim at.
    const aimed = new Set(g.stack.filter((s) => s.controller === p.seat).flatMap((s) => s.targets).flatMap((t) => (t?.kind === 'perm' ? [t.id] : [])));
    let best: { target: Target; score: number } | null = null;
    for (const t of candidates) {
      let score = 0;
      if (t.kind === 'perm' && aimed.has(t.id)) continue;
      if (t.kind === 'player') {
        // "Any target" burn: only go face to finish someone.
        const o = g.players[t.seat];
        if (o === p || o.life > amount) continue;
        score = 50;
      } else if (t.kind === 'perm') {
        const perm = g.findPerm(t.id);
        if (!perm || perm.seat === p.seat || !g.removable(e.target, perm)) continue;
        if (perm.landInfo) {
          score = this.landTargetScore(g, perm);
          if (!best || score > best.score) best = { target: t, score };
          continue;
        }
        if (e.mode === 'destroy' && g.hasKw(perm, 'indestructible')) continue;
        if (e.mode === 'damage' && amount < g.toughness(perm) - perm.damage) continue;
        // -N/-N kills through indestructible; damage doesn't.
        if (e.mode === 'damage' && !e.shrink && g.hasKw(perm, 'indestructible')) continue;
        if (e.mode === 'fight' && (!fighter || (g.power(fighter) < g.toughness(perm) - perm.damage && !g.hasKw(fighter, 'deathtouch')))) continue;
        const leader = boardThreat(g, g.players[perm.seat]) > 15 ? 1.2 : 1;
        score = threat(g, perm) * leader;
        // Fblthp shuffles itself away when targeted: the spell would be wasted.
        if (perm.card.effects.some((f) => f.kind === 'shuffleWhenTargeted')) score *= 0.2;
        if (g.hasKw(perm, 'ward')) score *= 0.6;
        if (e.mode === 'bounce') score *= perm.token ? 1.3 : 0.7;
      } else continue;
      if (!best || score > best.score) best = { target: t, score };
    }
    return best;
  }

  /**
   * Prevent combat damage when an attack on us would kill us or take a big bite: Fog, Spore Frog,
   * Inkshield, or Maze of Ith on the biggest attacker.
   */
  private chooseFog(g: Game, p: PlayerState, actions: Action[]): Action | undefined {
    const coming = g.attackers().filter((a) => a.attacking === p.seat && (!a.blocked || g.hasKw(a, 'trample')) && !a.fogged);
    if (!coming.length) return undefined;
    const total = coming.reduce((n, a) => n + hitDamage(g, a), 0);
    const biggest = Math.max(...coming.map((a) => hitDamage(g, a)));
    const lethal = total >= p.life || coming.some((a) => a.isCommander && hitDamage(g, a) >= 21 - Math.max(0, ...[...p.commanderDamage.values()]));
    const fogOf = (a: Action) => (a.type === 'cast' && a.from !== 'alt' ? a.card.effects.find((e) => e.kind === 'fog' || e.kind === 'preventNext') : a.type === 'activate' && a.effect.kind === 'fog' ? a.effect : undefined);
    let best: Action | undefined;
    let bestSaved = 0;
    for (const a of actions) {
      const f = fogOf(a);
      if (!f || (f.kind !== 'fog' && f.kind !== 'preventNext') || (f.kind === 'preventNext' && p.preventNext)) continue;
      // Deflecting Palm: one source (the biggest hit), and it hits back.
      const one = f.kind === 'preventNext' || f.who === 'creature';
      const saved = one ? biggest * (f.kind === 'preventNext' && f.reflect ? 2 : 1) : total;
      // A one-creature answer only matters if it takes us out of lethal, or blunts a big hit.
      if (one && lethal && total - biggest >= p.life) continue;
      if (saved > bestSaved) {
        best = a;
        bestSaved = saved;
      }
    }
    if (!best) return undefined;
    const isSpell = best.type === 'cast';
    // Spells are cards: kept for real danger. Abilities (Maze of Ith) are free to use on any good hit.
    if (lethal || bestSaved >= Math.max(isSpell ? 10 : 4, p.life * (isSpell ? 0.4 : 0.15))) return best;
    return undefined;
  }

  /** Colors `q` could make now but not once every nonbasic land taps only for `into` (Blood Moon). */
  private colorsLost(g: Game, q: PlayerState, into: Mana): number {
    const now = new Set<Mana>();
    const after = new Set<Mana>([into]);
    for (const l of q.battlefield) {
      if (!l.landInfo) continue;
      const made = g.landProduces(l);
      for (const c of made === 'any' ? q.identity : made) {
        now.add(c);
        if (l.card.isBasic) after.add(c);
      }
    }
    return q.identity.filter((c) => now.has(c) && !after.has(c)).length;
  }

  /** How good a land is to destroy: nonbasic, fixing, a color its controller has nowhere else, a player short on lands. */
  private landTargetScore(g: Game, land: Perm): number {
    const owner = g.players[land.seat];
    const makes = g.landProduces(land);
    let score = 2;
    if (!land.card.isBasic) score += 1.5;
    if (makes === 'any' || makes.length >= 2) score += 1;
    // The only source of one of its controller's colors.
    const others = owner.battlefield.filter((q) => q.landInfo && q !== land).map((q) => g.landProduces(q));
    const colors = makes === 'any' ? owner.identity : makes.filter((m) => m !== 'C');
    if (colors.some((c) => !others.some((o) => o === 'any' || o.includes(c)))) score += 2;
    if (g.landCount(owner) <= 4) score += 1;
    if (boardThreat(g, owner) > 15) score += 1;
    if ((this.plan?.landHate ?? 0) >= 8) score += 2;
    return score;
  }

  /**
   * Whether land hate is worth casting now, and how much: Blood Moon when opponents lean on nonbasic lands
   * more than we do, Armageddon-style wipes when we are ahead on board, and anything for a deck built on it.
   */
  private landHateWorth(g: Game, p: PlayerState, card: SimCard): number | null {
    const hater = (this.plan?.landHate ?? 0) >= 8;
    const opps = g.opponents(p);
    if (!opps.length) return null;
    const nonbasic = (q: PlayerState) => q.battlefield.filter((l) => l.landInfo && !l.card.isBasic).length;
    const lands = (q: PlayerState) => g.landCount(q);
    const avg = (f: (q: PlayerState) => number) => opps.reduce((n, q) => n + f(q), 0) / opps.length;
    const board = (q: PlayerState) => boardThreat(g, q, true);
    let worth = 0;
    for (const e of card.effects) {
      switch (e.kind) {
        case 'landRule': {
          if (e.rule === 'everyType') break;
          if (e.rule === 'untapOneLand') {
            // Winter Orb: everyone is choked; good for a deck that needs little mana or already has its board.
            if (!hater && board(p) <= avg(board)) return null;
            worth += 5;
            break;
          }
          const gap = avg(nonbasic) - nonbasic(p);
          // Blood Moon and Harbinger also cut opponents off colors their basic lands don't make.
          const turnsInto: Mana | null = e.rule === 'nonbasicMountains' ? 'R' : e.rule === 'nonbasicIslands' ? 'U' : null;
          const cut = turnsInto ? opps.reduce((n, q) => n + this.colorsLost(g, q, turnsInto), 0) - this.colorsLost(g, p, turnsInto) : 0;
          if (gap < 1.5 && cut <= 0 && !(hater && gap >= 0)) return null;
          worth += Math.min(15, gap * 2) + cut * 4;
          break;
        }
        case 'tapPunish': {
          if (e.what === 'tapAll' || e.opponents) {
            worth += 6;
            break;
          }
          const mine = e.nonbasic ? nonbasic(p) : lands(p);
          const theirs = e.nonbasic ? avg(nonbasic) : avg(lands);
          if (!hater && theirs < mine + 1) return null;
          worth += 4;
          break;
        }
        case 'landWipe': {
          if (e.nonbasic) {
            const gap = avg(nonbasic) - nonbasic(p);
            if (gap < 1.5) return null;
            worth += gap * 2;
          } else {
            // Armageddon: when our board already wins without lands, or the deck is built for it and we are not behind.
            if (board(p) < avg(board) + 4 && !(hater && board(p) >= avg(board))) return null;
            worth += 10;
          }
          break;
        }
        case 'landSac': {
          const lose = e.keep !== undefined ? Math.max(0, lands(p) - e.keep) : e.n;
          const hit = e.keep !== undefined ? Math.max(0, avg(lands) - e.keep) : e.n;
          if (e.who === 'each' && hit <= lose && !hater) return null;
          if (e.who === 'each' && lands(p) <= 3 && e.keep === undefined) return null;
          worth += 3 + hit - (e.who === 'each' ? lose : 0);
          break;
        }
        case 'nonbasicBurn': {
          const theirs = opps.reduce((n, q) => n + nonbasic(q), 0) * e.per;
          const mine = nonbasic(p) * e.per;
          if (opps.some((q) => !q.shielded && nonbasic(q) * e.per >= q.life)) return 60;
          if (theirs < mine * 2 + 3 || mine >= p.life) return null;
          worth += theirs - mine;
          break;
        }
        case 'landDiesPunish':
          worth += hater ? 6 : 2;
          break;
      }
    }
    return worth;
  }

  /**
   * The X to use for a "-X" loyalty ability (rule 606.4), or 0 when no X is worth it. It keeps the planeswalker
   * alive unless X = all of its loyalty wins outright.
   */
  private loyaltyX(g: Game, p: PlayerState, a: Extract<Action, { type: 'activate' }>): number {
    const loyalty = g.findPerm(a.permId)?.loyalty ?? 0;
    const e = a.effect;
    const keep = Math.max(0, loyalty - 1);
    const times = e.xTimes ?? 1;
    switch (e.kind) {
      case 'wipe': {
        // Ugin: the X that takes the most from the opponents and the least from us.
        let best = 0;
        for (let x = 1; x <= keep; x++) if (this.wipeIsGood(g, p, e, x)) best = x;
        return best;
      }
      case 'mill': {
        // Jace: mill a library out if the loyalty is there, else as much as stays safe.
        const thinnest = Math.min(...g.opponents(p).map((o) => o.library.length));
        if (loyalty * times >= thinnest) return Math.min(loyalty, Math.ceil(thinnest / times));
        return keep;
      }
      case 'tutor': {
        const reach = p.library.filter((c) => c.isArtifact && !c.isLand && c.cmc <= keep && c.value >= 2).map((c) => c.cmc);
        return reach.length ? Math.max(...reach) : 0;
      }
      default:
        return keep;
    }
  }

  /** Unlock a Room's other door: its "when you unlock this door" must be good for us (Restricted Office's wipe). */
  private unlockWorth(g: Game, p: PlayerState, permId: number): boolean {
    const door = g.findPerm(permId)?.card.room?.door;
    if (!door) return false;
    for (const e of door.effects) {
      if (e.when !== 'unlock') continue;
      if (e.kind === 'wipe' && !this.wipeIsGood(g, p, e, 0)) return false;
    }
    return true;
  }

  private wipeIsGood(g: Game, p: PlayerState, e: Wipe, x: number): boolean {
    const creaturesOnly = e.target === 'creatures';
    const affects = (perm: Perm) => {
      if (perm.card.isLand || perm.emblem) return false;
      // Ugin, the Spirit Dragon: colored permanents with mana value X or less.
      if (e.maxCmc !== undefined && perm.card.cmc > (e.maxCmc === -1 ? x : e.maxCmc)) return false;
      if (e.colored && !cardColors(perm.card).length) return false;
      if (creaturesOnly && !perm.card.isCreature) return false;
      // Wrath of the Skies: up to the energy we will have.
      if (e.byEnergy && perm.card.cmc > Math.max(0, x) + p.energy) return false;
      if (e.mode === 'damage') return perm.card.isCreature && (e.amount === -1 ? x : e.amount) >= g.toughness(perm) && (!!e.shrink || !g.hasKw(perm, 'indestructible'));
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

  /**
   * The creature to tap to station a Spacecraft or Planet, or null to wait: before combat only one that can't
   * attack anyway, after combat the strongest one left, but never a creature whose own tap ability matters.
   */
  stationDriver(g: Game, p: PlayerState, permId: number): Perm | null {
    const host = g.findPerm(permId);
    if (!host || g.activeSeat !== p.seat) return null;
    const attackers = new Set(g.attackCandidates(p));
    const ok = g.stationCrew(p, host).filter((q) => !q.card.effects.some((e) => e.when === 'activated' && e.activation?.tap) && !q.isCommander);
    const pool = g.step === 'main1' ? ok.filter((q) => !attackers.has(q)) : ok;
    return pool[0] ?? null;
  }

  private readyAttackers(g: Game, p: PlayerState): Perm[] {
    return g.attackCandidates(p).filter((c) => g.power(c) > 0);
  }

  private attackScore(g: Game, o: PlayerState, blockers: Perm[], unblockable: number, total: number): number {
    let score = 0;
    if (unblockable >= o.life) score += 100;
    else if (total - blockers.length * 2 >= o.life) score += 25;
    score += boardThreat(g, o) * 0.4;
    // Gang up on whoever is running away with the game, rather than on whoever is lowest.
    score += archenemyLead(g, o, this.seat) * 0.5;
    // Combat damage to the monarch takes the crown (rule 724.2), and with it a card every turn.
    if (g.monarch === o.seat) score += 6;
    score -= blockers.reduce((s, b) => s + g.power(b), 0) * 0.3;
    return score;
  }

  private attack(g: Game, p: PlayerState, candidateIds: number[], defenderSeats: number[], goaded: { attacker: number; defenders: number[] }[] = []): AttackDeclaration[] {
    // Goaded creatures must attack; they go where they do the most good among the players they may attack.
    const forced: AttackDeclaration[] = [];
    for (const gd of goaded) {
      const perm = g.findPerm(gd.attacker);
      if (!perm) continue;
      const allowed = gd.defenders.map((s) => g.players[s]).filter((o) => o.alive);
      if (!allowed.length) continue;
      const score = (o: PlayerState) => this.attackScore(g, o, o.battlefield.filter((b) => b.card.isCreature && !b.tapped && g.canBlock(b, perm)), 0, g.playerProtectedFrom(o, p.seat) ? 0 : hitDamage(g, perm));
      forced.push({ attacker: perm.id, defender: allowed.reduce((a, b) => (score(b) > score(a) ? b : a)).seat });
    }
    candidateIds = candidateIds.filter((id) => !forced.some((f) => f.attacker === id));
    if (forced.length) return [...forced, ...this.attack(g, p, candidateIds, defenderSeats)];
    let candidates = candidateIds.map((id) => g.findPerm(id)).filter((q): q is Perm => q !== null && g.power(q) > 0);
    // Absolute Virtue: nothing gets through to a player with protection from us, so they aren't worth attacking.
    const opps = defenderSeats.map((s) => g.players[s]).filter((o) => o.alive && !g.playerProtectedFrom(o, p.seat));
    if (!candidates.length || !opps.length) return [];

    // Main target: who is most worth hitting, and can be hit.
    let main = opps[0];
    let mainScore = -Infinity;
    for (const o of opps) {
      const blockers = o.battlefield.filter((b) => b.card.isCreature && !b.tapped);
      let unblockable = 0;
      let total = 0;
      for (const a of candidates) {
        if (!g.canAttack(a, o.seat)) continue;
        total += hitDamage(g, a);
        if (!blockers.some((b) => g.canBlock(b, a))) unblockable += hitDamage(g, a);
      }
      const tax = g.attackTax(o);
      const payable = tax ? Math.min(candidates.length, Math.floor(g.availableMana(p) / tax)) : candidates.length;
      const score = this.attackScore(g, o, blockers, unblockable * (payable / candidates.length), total * (payable / candidates.length)) - (candidates.length - payable) * 4 + this.rng.next() * 8;
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
    // Attack taxes (Propaganda, Ghostly Prison) are paid per creature; one we can't pay for stays home, so send it elsewhere.
    let budget = g.availableMana(p);
    // Crawlspace: only so many creatures can attack each player.
    const sent = new Map<number, number>();
    for (const a of candidates) {
      for (const o of order) {
        if (!g.canAttack(a, o.seat) || (sent.get(o.seat) ?? 0) >= g.attackLimit(o.seat)) continue;
        const tax = g.attackTax(o, a);
        if (tax > budget) continue;
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
          sent.set(o.seat, (sent.get(o.seat) ?? 0) + 1);
          budget -= tax;
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
        if (a.isCommander && (d.commanderDamage.get(`${a.seat}:${commanderName(a)}`) ?? 0) + hitDamage(g, a) >= 21) commanderLethal = true;
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

  /** What casting this spell for free is worth now, or 0 when it would hurt us (a wipe of our board, milling ourselves). */
  private freeWorth(g: Game, p: PlayerState, c: SimCard): number {
    const wipe = c.effects.find((e): e is Wipe => e.kind === 'wipe' && e.when === 'resolve');
    if (wipe && !this.wipeIsGood(g, p, wipe, 0)) return 0;
    if (c.effects.some((e) => e.kind === 'mill' && e.who === 'you' && e.when === 'resolve') && p.library.length < 20) return 0;
    if (c.effects.length && c.effects.every((e) => REACTIVE_KINDS.has(e.kind)) && !c.isCreature) return 0.5;
    return c.value + c.cmc;
  }

  private choose(g: Game, p: PlayerState, d: Extract<Decision, { kind: 'choose' }>): number[] {
    const indexes = d.options.map((_, i) => i);
    const top = (score: (i: number) => number, count: number) => [...indexes].sort((a, b) => score(b) - score(a)).slice(0, count);
    const card = (i: number) => d.options[i].card!;
    const perm = (i: number) => g.findPerm(d.options[i].permId ?? null);

    switch (d.reason) {
      case 'station': {
        // The choice doesn't name the Spacecraft; any of ours with room left picks the same driver.
        const host = p.battlefield.find((q) => g.stationRoom(q));
        const best = host ? this.stationDriver(g, p, host.id) : null;
        const at = best ? indexes.find((i) => d.options[i].permId === best.id) : undefined;
        return [at ?? 0];
      }
      case 'bottom':
      case 'discard': {
        const lands = p.hand.filter((c) => c.isLand).length;
        return top((i) => -this.cardScore(g, p, card(i), lands), d.min);
      }
      case 'tutor': {
        const needLand = g.landCount(p) < 4 && !p.hand.some((c) => c.isLand);
        // The missing piece of a combo beats anything else.
        const missing = missingComboPieces(p);
        return top((i) => (missing.has(card(i).name) ? 300 : 0) + (card(i).isLand === needLand ? 100 : 0) + card(i).value, 1);
      }
      case 'recursion':
        return top((i) => card(i).value, d.max);
      case 'entomb': {
        // Bin the cards the deck can use from the graveyard: big creatures for reanimation, flashback and escape cards.
        const reanimates = [...p.hand, ...p.battlefield.map((q) => q.card), ...p.deck.commanders].some((c) => c.effects.some((e) => e.kind === 'recursion' && e.toBattlefield));
        const score = (i: number) => card(i).value * (card(i).isCreature && reanimates ? 1.5 : 0.5) + (card(i).flashback || card(i).graveyard ? 4 : 0);
        return top(score, d.max);
      }
      case 'exileCard': {
        // Paying for escape: our least useful cards. Graveyard hate: their best.
        const own = (i: number) => p.graveyard.includes(card(i));
        return top((i) => (own(i) ? -card(i).value - (card(i).flashback || card(i).graveyard ? 5 : 0) : card(i).value), d.max);
      }
      case 'torment': {
        // Torment of Scarabs: lose the life while healthy, else give up the least useful card or permanent.
        const lands = p.hand.filter((c) => c.isLand).length;
        return top((i) => {
          const o = d.options[i];
          const q = perm(i);
          if (q) return q.token ? 2 - threat(g, q) * 0.3 : -threat(g, q);
          if (o.card) return -this.cardScore(g, p, o.card, lands) * 0.3 + (o.card.isLand && lands >= 2 ? 2 : 0);
          return p.life >= 25 ? 3 : p.life >= 12 ? 0 : -20;
        }, 1);
      }
      case 'copySpell': {
        // Ivy: copy it onto our own creature only when it helps that creature.
        const item = g.stack.find((s) => s.card === d.options[0]?.card);
        return item && item.effects.length > 0 && item.effects.every((e) => KIND_TO_US.has(e.kind)) ? [0] : [];
      }
      case 'payCost': {
        // Wandering Archaic: pay to keep our good spell from being copied.
        const item = g.stack.find((s) => s.card === d.options[0]?.card && s.controller === p.seat);
        return item && stackWorth(item) >= 2 ? [0] : [];
      }
      case 'sacrifice':
        // Treasures first, then what we only borrowed, then tokens and the least useful permanents; lands only when there are plenty.
        return top((i) => {
          const q = perm(i);
          if (!q) return d.options[i].label === 'Treasure' ? 100 : 0;
          if (q.borrowed) return 50;
          return -threat(g, q) - (q.landInfo ? (g.landCount(p) > 7 ? 1 : 6) : 0) + (q.token ? 1 : 0);
        }, d.min);
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
      case 'blink':
        return indexes.filter((i) => perm(i) && this.blinkWorth(g, p, perm(i)!) >= 2).slice(0, d.max);
      case 'pitch':
        return top((i) => -card(i).value, 1);
      case 'untap': {
        // Mana first: lands and mana rocks, then creatures.
        const worth = (q: Perm | null) => (!q ? 0 : q.landInfo ? 3 : q.card.effects.some((e) => e.kind === 'mana') ? 4 : q.card.isCreature ? 1 : 0.5);
        return top((i) => worth(perm(i)), d.max);
      }
      case 'manifest':
        // Manifest dread: a creature card can be turned face up later.
        return top((i) => (card(i).isCreature ? 10 : 0) + card(i).value, 1);
      case 'cipher':
        // Encode on the creature most likely to connect: evasion first, then power.
        return top((i) => {
          const q = perm(i);
          if (!q) return 0;
          return g.power(q) + (g.hasKw(q, 'flying') || g.hasKw(q, 'unblockable') ? 5 : 0) - (q.tapped ? 1 : 0);
        }, 1);
      case 'gift': {
        // Give the gift to the opponent least able to use it: the one with the lowest life and smallest board.
        const opps = g.opponents(p);
        return top((i) => -(opps[i] ? opps[i].life + boardThreat(g, opps[i], false) * 2 : 0), 1);
      }
      case 'hideaway':
        // Hide the best card: it is played for free later.
        return top((i) => card(i).value + card(i).cmc * 0.5 - (card(i).isLand ? 3 : 0), 1);
      case 'impulse':
        // Exile the cards we would most like to play: spells we can afford, a land if we need one.
        return top((i) => this.cardScore(g, p, card(i), p.hand.filter((c) => c.isLand).length) + (card(i).isLand && g.landCount(p) < 5 ? 3 : 0), d.min);
      case 'freeCast':
        // Cast for free: the biggest useful spell, never one that would only hurt us.
        return top((i) => (this.freeWorth(g, p, card(i)) > 0 ? 100 + this.freeWorth(g, p, card(i)) : -1), 1).filter((i) => this.freeWorth(g, p, card(i)) > 0);
      case 'rearrange': {
        // Best cards on top: what we can cast soon, a land when short. Ponder shuffles when nothing is worth keeping.
        const lands = g.landCount(p) + p.hand.filter((c) => c.isLand).length;
        const worth = (c: SimCard) => (c.isLand ? (lands < 5 ? 6 : lands >= 8 ? -2 : 1) : !c.modeled ? -1 : c.cmc > g.landCount(p) + 3 ? 0.5 : c.value);
        const order = top((i) => worth(card(i)), d.options.length);
        if (d.min === 0 && order.every((i) => worth(card(i)) <= 1)) return [];
        return order;
      }
      case 'mutate': {
        // On top when the new card brings the better body: power counts double, evasion helps.
        const body = (c: SimCard) => c.power * 2 + c.toughness + (c.keywords.includes('flying') || c.keywords.includes('unblockable') ? c.power : 0);
        return [body(card(0)) > body(card(1)) ? 0 : 1];
      }
    }
    return top(() => 0, d.min);
  }
}
