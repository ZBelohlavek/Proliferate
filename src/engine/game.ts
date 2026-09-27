// The game engine: plays one game of multiplayer Commander between 2–6 decks.
//
// It follows the real turn structure (untap, upkeep, draw, main, combat, main,
// end) with Commander rules: 40 life, commander tax, 21 commander damage,
// and the command zone. Decisions are made by a simple heuristic AI.
//
// Everything a card does comes from the Effects the classifier found. The
// engine never reads oracle text.

import { Rng } from './rng';
import type {
  CastFilter,
  Color,
  Effect,
  Elimination,
  GameResult,
  LandInfo,
  LossReason,
  Mana,
  ManaCost,
  SimCard,
  SimDeck,
  Trigger,
} from './types';

// ---------------------------------------------------------------------------
// Game state
// ---------------------------------------------------------------------------

export interface Perm {
  id: number;
  card: SimCard;
  seat: number;
  tapped: boolean;
  /** Summoning sick: entered this turn, can't attack or tap for mana. */
  sick: boolean;
  token: boolean;
  isCommander: boolean;
  counters: number;
  damage: number;
  deathtouched: boolean;
  tempP: number;
  tempT: number;
  tempKw: string[];
  /** For equipment/auras: the creature they are attached to. */
  attachedTo: number | null;
  activations: number;
  /** Once-per-turn triggers already used this turn. */
  usedThisTurn: Effect[];
  /** For lands: what they tap for. For MDFCs played as lands, the back face. */
  landInfo?: LandInfo;
}

export interface Player {
  seat: number;
  deck: SimDeck;
  identity: Color[];
  life: number;
  library: SimCard[];
  hand: SimCard[];
  graveyard: SimCard[];
  battlefield: Perm[];
  commandZone: SimCard[];
  commanderCasts: Map<string, number>;
  /** Commander damage taken, keyed by "seat:commander name". */
  commanderDamage: Map<string, number>;
  treasures: number;
  alive: boolean;
  drewFromEmpty: boolean;
  landsPlayed: number;
  lastHitBy: number | null;
  lastHitKind: LossReason;
  commanderRound: number | null;
  mulligans: number;
  /** Names of cards drawn at random (opening hand and draws) and cast/played, for card stats. */
  earlyNames: Set<string>;
  drawnNames: Set<string>;
  castNames: Set<string>;
  /** Seat -> round in which that player last attacked this one. */
  attackedBy: Map<number, number>;
  /** Per-game personality: >1 attacks more eagerly. */
  aggression: number;
}

export interface GameOptions {
  maxRounds?: number;
  log?: boolean;
}

export interface CastChoice {
  card: SimCard;
  fromCommandZone: boolean;
  x: number;
}

interface ManaSource {
  perm: Perm | null; // null = a Treasure token
  colors: Mana[] | 'any';
  amount: number;
}

const ALL_COLORS: Mana[] = ['W', 'U', 'B', 'R', 'G'];
/** Library cards (after the opening hand) counted as "early" for card stats: roughly the first 8 turns of draws. */
const EARLY_LIBRARY_CARDS = 8;
const REACTIVE_KINDS = new Set(['counter', 'pump', 'protect']);

export class Game {
  readonly players: Player[];
  readonly rng: Rng;
  round = 0;
  activeSeat = 0;
  readonly log: string[] | null;
  private nextId = 1;
  private readonly maxRounds: number;
  private readonly eliminations: Elimination[] = [];
  private readonly placements: number[];
  private triggerBudget = 0;

  constructor(decks: SimDeck[], seed: number, opts: GameOptions = {}) {
    if (decks.length < 2 || decks.length > 6) throw new Error(`A game needs 2–6 players, got ${decks.length}.`);
    this.rng = new Rng(seed);
    this.maxRounds = opts.maxRounds ?? 25;
    this.log = opts.log ? [] : null;
    this.placements = decks.map(() => 0);
    this.players = decks.map((deck, seat) => ({
      seat,
      deck,
      identity: deck.colorIdentity,
      life: 40,
      library: [],
      hand: [],
      graveyard: [],
      battlefield: [],
      commandZone: [...deck.commanders],
      commanderCasts: new Map(),
      commanderDamage: new Map(),
      treasures: 0,
      alive: true,
      drewFromEmpty: false,
      landsPlayed: 0,
      lastHitBy: null,
      lastHitKind: 'combat',
      commanderRound: null,
      mulligans: 0,
      earlyNames: new Set(),
      drawnNames: new Set(),
      castNames: new Set(),
      attackedBy: new Map(),
      aggression: 0.8 + this.rng.next() * 0.5,
    }));
  }

  // -------------------------------------------------------------------------
  // Top level
  // -------------------------------------------------------------------------

  run(): GameResult {
    for (const p of this.players) this.openingHand(p);

    while (this.alivePlayers().length > 1 && this.round < this.maxRounds) {
      this.round++;
      for (const p of this.players) {
        if (!p.alive) continue;
        this.takeTurn(p);
        if (this.alivePlayers().length <= 1) break;
      }
    }

    const alive = this.alivePlayers();
    let winner: number | null = null;
    if (alive.length === 1) {
      winner = alive[0].seat;
      this.placements[winner] = 1;
      this.say(`${this.name(alive[0])} wins on round ${this.round}.`);
    } else {
      // Turn limit: survivors share the top places.
      const shared = (1 + alive.length) / 2;
      for (const p of alive) {
        this.placements[p.seat] = shared;
        this.eliminations.push({ seat: p.seat, round: this.round, reason: 'timeout', killer: null });
      }
      this.say(`Turn limit reached — draw between ${alive.map((p) => this.name(p)).join(', ')}.`);
    }

    return {
      seats: this.players.map((p) => p.deck.id),
      winner,
      placements: this.placements,
      rounds: this.round,
      eliminations: this.eliminations,
      commanderRound: this.players.map((p) => p.commanderRound),
      mulligans: this.players.map((p) => p.mulligans),
      cards: this.players.map((p) => ({ early: [...p.earlyNames], drawn: [...p.drawnNames], cast: [...p.castNames] })),
    };
  }

  /**
   * For the Playstyle quiz: play normally until `seat`'s turn in `round`,
   * then stop after its untap, upkeep, draw and land drop — right where the
   * player would start making decisions. Returns false if that turn never
   * comes (the player died or the game ended).
   */
  advanceTo(round: number, seat: number): boolean {
    for (const p of this.players) this.openingHand(p);
    while (this.alivePlayers().length > 1 && this.round < round) {
      this.round++;
      for (const p of this.players) {
        if (!p.alive) continue;
        if (this.round === round && p.seat === seat) return this.beginTurn(p);
        this.takeTurn(p);
        if (this.alivePlayers().length <= 1) return false;
      }
    }
    return false;
  }

  alivePlayers(): Player[] {
    return this.players.filter((p) => p.alive);
  }

  opponents(p: Player): Player[] {
    return this.players.filter((o) => o.alive && o !== p);
  }

  private say(msg: string) {
    if (this.log) this.log.push(msg);
  }

  private name(p: Player): string {
    return `${p.deck.commanders[0]?.name ?? p.deck.name} (P${p.seat + 1})`;
  }

  // -------------------------------------------------------------------------
  // Setup and mulligans
  // -------------------------------------------------------------------------

  private openingHand(p: Player) {
    const cards: SimCard[] = [];
    for (const entry of p.deck.cards) for (let i = 0; i < entry.count; i++) cards.push(entry.card);
    p.library = this.rng.shuffle(cards);

    // Commander has a free first mulligan; after that, London mulligan (put cards on the bottom).
    for (let attempt = 0; attempt < 4; attempt++) {
      p.hand = p.library.splice(0, 7);
      const toBottom = Math.max(0, attempt - 1);
      if (attempt === 3 || this.keepable(p.hand, toBottom)) {
        for (let i = 0; i < toBottom; i++) {
          const worst = this.worstCard(p, p.hand);
          p.hand.splice(p.hand.indexOf(worst), 1);
          p.library.push(worst);
        }
        p.mulligans = attempt;
        for (const c of p.hand) p.drawnNames.add(c.name);
        for (const c of [...p.hand, ...p.library.slice(0, EARLY_LIBRARY_CARDS)]) p.earlyNames.add(c.name);
        break;
      }
      p.library.push(...p.hand);
      this.rng.shuffle(p.library);
    }
    this.say(`${this.name(p)} keeps ${p.hand.length}${p.mulligans ? ` after ${p.mulligans} mulligan(s)` : ''}.`);
  }

  private keepable(hand: SimCard[], toBottom: number): boolean {
    let lands = 0;
    let cheapRamp = 0;
    for (const c of hand) {
      if (c.isLand || c.backLand) lands++;
      else if (c.cmc <= 3 && c.effects.some((e) => e.kind === 'mana' || e.kind === 'ramp')) cheapRamp++;
    }
    const effective = lands + cheapRamp * 0.5;
    const size = 7 - toBottom;
    return effective >= 2.5 && lands >= 2 && lands <= Math.max(5, size - 1);
  }

  private worstCard(p: Player, cards: SimCard[]): SimCard {
    const landCount = this.landCount(p) + cards.filter((c) => c.isLand).length;
    let worst = cards[0];
    let worstScore = Infinity;
    for (const c of cards) {
      // Extra lands are worth little once we have plenty.
      const score = c.isLand ? (landCount > 6 ? 0.5 : 6) : c.value - c.cmc * 0.2;
      if (score < worstScore) {
        worst = c;
        worstScore = score;
      }
    }
    return worst;
  }

  // -------------------------------------------------------------------------
  // Turn structure
  // -------------------------------------------------------------------------

  private takeTurn(p: Player) {
    if (this.beginTurn(p)) this.finishTurn(p);
  }

  /** Untap, upkeep, draw and the first land drop. Returns false if the player died. */
  private beginTurn(p: Player): boolean {
    this.activeSeat = p.seat;
    this.triggerBudget = 300;
    this.say(`— Round ${this.round}, ${this.name(p)} (life ${p.life}) —`);

    for (const perm of p.battlefield) {
      perm.tapped = false;
      perm.sick = false;
      perm.activations = 0;
    }
    for (const q of this.players) for (const perm of q.battlefield) perm.usedThisTurn = [];
    p.landsPlayed = 0;

    this.fireTrigger(p, 'upkeep');
    this.checkState();
    if (!p.alive) return false;

    this.draw(p, 1);
    this.checkState();
    if (!p.alive) return false;

    this.playLand(p);
    return true;
  }

  private finishTurn(p: Player) {
    this.mainPhase(p);
    if (!p.alive) return;

    this.combat(p);
    this.checkState();
    if (!p.alive) return;

    this.playLand(p);
    this.mainPhase(p);
    this.useActivatedAbilities(p);

    // End step: discard down to 7, then clean up damage and "until end of turn" effects.
    while (p.hand.length > 7) {
      const worst = this.worstCard(p, p.hand);
      p.hand.splice(p.hand.indexOf(worst), 1);
      p.graveyard.push(worst);
    }
    for (const q of this.players) {
      for (const perm of q.battlefield) {
        perm.damage = 0;
        perm.deathtouched = false;
        perm.tempP = 0;
        perm.tempT = 0;
        perm.tempKw = [];
      }
    }

    // The next player gets an end-of-turn window to use instants with mana they'd otherwise waste.
    const next = this.nextAlive(p);
    if (next && next !== p) {
      this.instantWindow(next);
      this.checkState();
    }
  }

  private nextAlive(p: Player): Player | null {
    for (let i = 1; i <= this.players.length; i++) {
      const q = this.players[(p.seat + i) % this.players.length];
      if (q.alive) return q;
    }
    return null;
  }

  private draw(p: Player, n: number) {
    for (let i = 0; i < n; i++) {
      const c = p.library.shift();
      if (!c) {
        p.drewFromEmpty = true;
        return;
      }
      p.hand.push(c);
      p.drawnNames.add(c.name);
    }
  }

  // -------------------------------------------------------------------------
  // Lands
  // -------------------------------------------------------------------------

  private landCount(p: Player): number {
    let n = 0;
    for (const perm of p.battlefield) if (perm.landInfo) n++;
    return n;
  }

  private playLand(p: Player) {
    if (p.landsPlayed >= 1) return;
    const options: { card: SimCard; info: LandInfo; mdfc: boolean }[] = [];
    for (const c of p.hand) {
      if (c.isLand && c.land) options.push({ card: c, info: c.land, mdfc: false });
      else if (c.backLand) options.push({ card: c, info: c.backLand, mdfc: true });
    }
    if (!options.length) return;

    const available = this.availableMana(p);
    const maxCost = Math.max(0, ...p.hand.filter((c) => !c.isLand).map((c) => this.effectiveCost(p, c)));
    const haveColors = this.colorsAvailable(p);
    const needed = new Set<Mana>();
    for (const c of p.hand) for (const pip of c.cost.pips) if (!pip.some((m) => haveColors.has(m))) pip.forEach((m) => needed.add(m));

    let best = options[0];
    let bestScore = -Infinity;
    for (const o of options) {
      let score = 0;
      if (o.mdfc) score -= this.landCount(p) >= 4 ? 8 : 3; // rather cast the spell side later
      if (!o.info.tapped) score += 2;
      // If we can't use the extra mana this turn anyway, get tapped lands out of the way.
      else if (maxCost <= available) score += 3;
      const produces = o.info.produces === 'any' ? ALL_COLORS : o.info.produces;
      for (const m of produces) if (needed.has(m)) score += 3;
      if (o.info.produces === 'any') score += 1;
      if (score > bestScore) {
        best = o;
        bestScore = score;
      }
    }
    if (best.mdfc && this.landCount(p) >= 5) return;
    p.hand.splice(p.hand.indexOf(best.card), 1);
    this.putLand(p, best.card, best.info);
    p.landsPlayed++;
    p.castNames.add(best.card.name);
  }

  private putLand(p: Player, card: SimCard, info: LandInfo, forceTapped = false) {
    const perm = this.makePerm(p, card, false);
    perm.landInfo = info;
    perm.tapped = forceTapped || info.tapped;
    perm.sick = false;
    p.battlefield.push(perm);
    this.say(`${this.name(p)} plays ${info === card.backLand ? card.backLand.name : card.name}.`);
    this.fireTrigger(p, 'landfall');
  }

  // -------------------------------------------------------------------------
  // Mana
  // -------------------------------------------------------------------------

  private manaSources(p: Player, exclude?: Perm): ManaSource[] {
    const out: ManaSource[] = [];
    for (const perm of p.battlefield) {
      if (perm.tapped || perm === exclude) continue;
      if (perm.landInfo) {
        out.push({ perm, colors: perm.landInfo.produces, amount: 1 });
        continue;
      }
      if (perm.sick && perm.card.isCreature) continue;
      for (const e of perm.card.effects) {
        if (e.kind === 'mana') out.push({ perm, colors: e.colors, amount: e.amount });
      }
    }
    for (let i = 0; i < p.treasures; i++) out.push({ perm: null, colors: 'any', amount: 1 });
    return out;
  }

  availableMana(p: Player): number {
    let n = 0;
    for (const s of this.manaSources(p)) n += s.amount;
    return n;
  }

  private colorsAvailable(p: Player): Set<Mana> {
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

  private costReduction(p: Player, card: SimCard): number {
    let n = 0;
    for (const perm of p.battlefield) {
      for (const e of perm.card.effects) {
        if (e.kind === 'costReduction' && matchesFilter(card, e.filter)) n += e.amount;
      }
    }
    return n;
  }

  private commanderTax(p: Player, card: SimCard, fromCommandZone: boolean): number {
    return fromCommandZone ? 2 * (p.commanderCasts.get(card.name) ?? 0) : 0;
  }

  /** Total mana a spell would cost right now (for AI planning). */
  effectiveCost(p: Player, card: SimCard, fromCommandZone = false, x = 0): number {
    const base = card.cost.generic + card.cost.x * x + this.commanderTax(p, card, fromCommandZone);
    return Math.max(0, base - this.costReduction(p, card)) + card.cost.pips.length;
  }

  /**
   * Work out which sources pay for a cost. Returns the sources and how many
   * units each contributes, or null if we can't afford it. Greedy: pay the
   * hardest colored pips first with the least flexible sources.
   */
  private planPayment(p: Player, cost: ManaCost, extraGeneric: number, reduction: number, exclude?: Perm): Map<ManaSource, number> | null {
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

    const pips = [...cost.pips].sort((a, b) => sources.filter((s) => can(s, a)).length - sources.filter((s) => can(s, b)).length);
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
        // Prefer leftovers from sources we already tapped, then sources that fit exactly, then least flexible.
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

  private commitPayment(p: Player, plan: Map<ManaSource, number>) {
    for (const [src, units] of plan) {
      if (src.perm) src.perm.tapped = true;
      else p.treasures -= units;
    }
  }

  canAfford(p: Player, card: SimCard, fromCommandZone = false, x = 0): boolean {
    return this.planPayment(p, card.cost, card.cost.x * x + this.commanderTax(p, card, fromCommandZone), this.costReduction(p, card)) !== null;
  }

  private pay(p: Player, card: SimCard, fromCommandZone: boolean, x: number): boolean {
    const plan = this.planPayment(p, card.cost, card.cost.x * x + this.commanderTax(p, card, fromCommandZone), this.costReduction(p, card));
    if (!plan) return false;
    this.commitPayment(p, plan);
    p.life -= card.cost.life;
    return true;
  }

  /** Largest X we could pay for this card right now. */
  private maxX(p: Player, card: SimCard, fromCommandZone = false): number {
    if (card.cost.x === 0) return 0;
    let x = 0;
    while (x < 20 && this.canAfford(p, card, fromCommandZone, x + 1)) x++;
    return x;
  }

  // -------------------------------------------------------------------------
  // Casting spells (AI)
  // -------------------------------------------------------------------------

  private mainPhase(p: Player) {
    for (let i = 0; i < 25 && p.alive; i++) {
      const choice = this.chooseSpell(p, false);
      if (!choice) break;
      this.castSpell(p, choice.card, choice.fromCommandZone, choice.x);
      this.checkState();
    }
  }

  /** At the end of the previous player's turn: flash creatures, instant removal and draw, then abilities. */
  private instantWindow(p: Player) {
    for (let i = 0; i < 10 && p.alive; i++) {
      const choice = this.chooseSpell(p, true);
      if (!choice) break;
      this.castSpell(p, choice.card, choice.fromCommandZone, choice.x);
      this.checkState();
    }
    if (p.alive) this.useActivatedAbilities(p);
  }

  private chooseSpell(p: Player, instantSpeed: boolean): CastChoice | null {
    const candidates = this.castCandidates(p, instantSpeed);
    if (!candidates.length) return null;
    return candidates.reduce((a, b) => (b.score > a.score ? b : a));
  }

  /** Spells the AI is willing to cast right now, with its own score for each. */
  castCandidates(p: Player, instantSpeed = false): (CastChoice & { score: number })[] {
    const available = this.availableMana(p);
    if (available === 0) return [];
    const reserve = instantSpeed ? 0 : this.reservedMana(p);

    const out: (CastChoice & { score: number })[] = [];
    const consider = (card: SimCard, fromCommandZone: boolean) => {
      if (card.isLand) return;
      if (instantSpeed && !card.isInstant && !card.keywords.includes('flash')) return;
      const x = this.maxX(p, card, fromCommandZone);
      if (card.cost.x > 0 && x < (card.isCreature ? 2 : 3)) return;
      if (!this.canAfford(p, card, fromCommandZone, x)) return;
      let score = this.castScore(p, card, fromCommandZone, x);
      if (score === null) return;
      // Keep mana up for counterspells/protection unless this play is important.
      if (reserve > 0 && score < 90 && available - this.effectiveCost(p, card, fromCommandZone, x) < reserve) return;
      score += card.cmc * 0.1;
      out.push({ card, fromCommandZone, x, score });
    };
    for (const c of p.commandZone) consider(c, true);
    for (const c of p.hand) consider(c, false);
    return out;
  }

  private reservedMana(p: Player): number {
    if (this.round < 3) return 0;
    let reserve = 0;
    for (const c of p.hand) {
      if (c.effects.some((e) => e.kind === 'counter' || e.kind === 'protect')) {
        const cost = this.effectiveCost(p, c);
        if (reserve === 0 || cost < reserve) reserve = cost;
      }
    }
    return reserve;
  }

  /** How much the AI wants to cast this now. null = don't cast. */
  private castScore(p: Player, card: SimCard, fromCommandZone: boolean, x: number): number | null {
    const kinds = new Set(card.effects.filter((e) => e.when === 'resolve' || e.when === 'static').map((e) => e.kind));
    if (fromCommandZone) return 85 + card.value;

    // Purely reactive spells are cast from other code paths.
    if (!card.isCreature && card.effects.length > 0 && card.effects.every((e) => REACTIVE_KINDS.has(e.kind))) return null;
    if (kinds.has('overrun')) return this.creaturesThatCanAttack(p).length >= 3 && !this.isInstantWindow(p) ? 60 : null;

    if (kinds.has('wipe')) {
      const wipe = card.effects.find((e) => e.kind === 'wipe')!;
      return this.wipeIsGood(p, wipe as Extract<Effect, { kind: 'wipe' }>, x) ? 95 : null;
    }

    let score = 0;
    if (kinds.has('mana') || kinds.has('ramp') || kinds.has('costReduction') || kinds.has('treasure') || kinds.has('extraLand')) {
      score = Math.max(score, 100 - this.round * 4);
    }
    if (kinds.has('removal')) {
      const removal = card.effects.find((e) => e.kind === 'removal' && e.when === 'resolve') as Extract<Effect, { kind: 'removal' }> | undefined;
      const target = removal ? this.chooseRemovalTarget(p, removal, x) : null;
      if (target) score = Math.max(score, 70 + target.threat);
      else if (!card.isCreature && !card.isArtifact && !card.isEnchantment) return null;
    }
    if (kinds.has('recursion') && !p.graveyard.some((c) => c.isCreature)) {
      if (!card.isCreature) return null;
    }
    if (card.effects.some((e) => e.kind === 'equip' && e.aura) && !p.battlefield.some((q) => q.card.isCreature)) return null;

    if (card.isCreature || card.isArtifact || card.isEnchantment || card.isPlaneswalker) score = Math.max(score, 50 + card.value);
    if (kinds.has('draw')) score = Math.max(score, 45 + card.value);
    if (kinds.has('tutor') || kinds.has('recursion') || kinds.has('tokens') || kinds.has('drain') || kinds.has('damagePlayer') || kinds.has('counters')) {
      score = Math.max(score, 40 + card.value);
    }
    if (kinds.has('gainLife')) score = Math.max(score, 10);
    if (!card.modeled) {
      if (card.isInstant || card.isSorcery) return null;
      score = Math.max(score, 1);
    }
    // Instants in the main phase: only if nothing better; they'll usually wait for the end-of-turn window.
    if (card.isInstant && !this.isInstantWindow(p) && !card.effects.some((e) => e.kind === 'ramp')) score = Math.min(score, 20);
    return score || null;
  }

  private isInstantWindow(p: Player): boolean {
    return this.activeSeat !== p.seat;
  }

  private castSpell(p: Player, card: SimCard, fromCommandZone: boolean, x: number) {
    if (!this.pay(p, card, fromCommandZone, x)) return;
    if (fromCommandZone) {
      p.commandZone.splice(p.commandZone.indexOf(card), 1);
      p.commanderCasts.set(card.name, (p.commanderCasts.get(card.name) ?? 0) + 1);
      if (p.commanderRound === null) p.commanderRound = this.round;
    } else {
      p.hand.splice(p.hand.indexOf(card), 1);
      p.castNames.add(card.name);
    }
    this.say(`${this.name(p)} casts ${card.name}${x ? ` (X=${x})` : ''}${fromCommandZone ? ' from the command zone' : ''}.`);

    this.fireCastTriggers(p, card);

    // Opponents may counter it.
    for (const q of this.opponents(p)) {
      if (this.tryCounter(q, p, card, fromCommandZone)) {
        if (fromCommandZone || this.isCommanderCard(p, card)) p.commandZone.push(card);
        else p.graveyard.push(card);
        return;
      }
    }
    this.resolveSpell(p, card, x, fromCommandZone || this.isCommanderCard(p, card));
  }

  private isCommanderCard(p: Player, card: SimCard): boolean {
    return p.deck.commanders.includes(card);
  }

  private resolveSpell(p: Player, card: SimCard, x: number, isCommander: boolean) {
    if (card.isInstant || card.isSorcery) {
      for (const e of card.effects) if (e.when === 'resolve') this.resolveEffect(p, e, null, x);
      p.graveyard.push(card);
      return;
    }
    const perm = this.makePerm(p, card, false);
    perm.isCommander = isCommander;
    if (card.entersWithX) perm.counters = x;
    p.battlefield.push(perm);
    const equip = card.effects.find((e) => e.kind === 'equip');
    if (equip) this.attachEquipment(p, perm);
    for (const e of card.effects) if (e.when === 'resolve') this.resolveEffect(p, e, perm, x);
    if (card.isCreature) this.fireCreatureEnters(p, perm);
  }

  private makePerm(p: Player, card: SimCard, token: boolean): Perm {
    return {
      id: this.nextId++,
      card,
      seat: p.seat,
      tapped: false,
      sick: true,
      token,
      isCommander: false,
      counters: 0,
      damage: 0,
      deathtouched: false,
      tempP: 0,
      tempT: 0,
      tempKw: [],
      attachedTo: null,
      activations: 0,
      usedThisTurn: [],
    };
  }

  private tryCounter(q: Player, caster: Player, card: SimCard, fromCommandZone: boolean): boolean {
    const counter = q.hand.find((c) => c.effects.some((e) => e.kind === 'counter' && counterMatches(e.target, card)));
    if (!counter || !this.canAfford(q, counter)) return false;

    let want = false;
    const wipe = card.effects.find((e) => e.kind === 'wipe') as Extract<Effect, { kind: 'wipe' }> | undefined;
    if (wipe) {
      const hurtsMe = this.boardThreat(q, wipe.target === 'creatures');
      const hurtsThem = this.boardThreat(caster, wipe.target === 'creatures');
      want = hurtsMe > 6 && (wipe.oneSided || hurtsMe > hurtsThem);
    } else if (fromCommandZone || card.value >= 9) {
      want = this.rng.chance(0.6);
    } else if (card.value >= 6) {
      want = this.rng.chance(0.25);
    }
    if (!want) return false;

    this.pay(q, counter, false, 0);
    q.hand.splice(q.hand.indexOf(counter), 1);
    q.graveyard.push(counter);
    this.fireCastTriggers(q, counter);
    this.say(`${this.name(q)} counters it with ${counter.name}.`);
    return true;
  }

  private fireCastTriggers(p: Player, card: SimCard) {
    for (const perm of [...p.battlefield]) {
      for (const e of perm.card.effects) {
        if (e.when === 'cast' && matchesFilter(card, e.castFilter ?? 'any') && card.cmc >= (e.minCmc ?? 0)) this.resolveEffect(p, e, perm, 0);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Activated abilities
  // -------------------------------------------------------------------------

  private useActivatedAbilities(p: Player) {
    for (let loop = 0; loop < 12; loop++) {
      let used = false;
      for (const perm of [...p.battlefield]) {
        if (!p.battlefield.includes(perm)) continue;
        for (const e of perm.card.effects) {
          if (e.when !== 'activated' || !e.activation) continue;
          const act = e.activation;
          if (act.tap && (perm.tapped || (perm.sick && perm.card.isCreature && !perm.landInfo))) continue;
          if (!act.tap && perm.activations >= 3) continue;
          if (!this.abilityWorthUsing(p, e)) continue;
          const plan = this.planPayment(p, act.cost, 0, 0, act.tap ? perm : undefined);
          if (!plan) continue;
          this.commitPayment(p, plan);
          p.life -= act.cost.life;
          if (act.tap) perm.tapped = true;
          perm.activations++;
          this.say(`${this.name(p)} activates ${perm.card.name}.`);
          if (act.sacrifice) this.removePerm(perm, 'graveyard');
          this.resolveEffect(p, e, act.sacrifice ? null : perm, 0);
          used = true;
          break;
        }
      }
      if (!used) break;
    }
  }

  private abilityWorthUsing(p: Player, e: Effect): boolean {
    switch (e.kind) {
      case 'draw': return p.library.length > 8;
      case 'tokens': case 'counters': case 'drain': case 'damagePlayer': case 'ramp': case 'tutor': case 'treasure': return true;
      case 'removal': return this.chooseRemovalTarget(p, e, 0) !== null;
      case 'recursion': return p.graveyard.some((c) => c.isCreature);
      default: return false;
    }
  }

  // -------------------------------------------------------------------------
  // Triggers
  // -------------------------------------------------------------------------

  private fireTrigger(p: Player, when: Trigger) {
    for (const perm of [...p.battlefield]) {
      if (!p.battlefield.includes(perm)) continue;
      for (const e of perm.card.effects) if (e.when === when) this.resolveEffect(p, e, perm, 0);
    }
  }

  private fireCreatureEnters(p: Player, entering: Perm) {
    for (const perm of [...p.battlefield]) {
      if (perm === entering) continue;
      for (const e of perm.card.effects) if (e.when === 'creatureEnters') this.resolveEffect(p, e, perm, 0);
    }
  }

  // -------------------------------------------------------------------------
  // Effect resolution
  // -------------------------------------------------------------------------

  private resolveEffect(p: Player, e: Effect, src: Perm | null, x: number) {
    if (!p.alive) return;
    if (this.triggerBudget-- <= 0) return;
    if (e.chance !== undefined && !this.rng.chance(e.chance)) return;
    if (e.oncePerTurn && src) {
      if (src.usedThisTurn.includes(e)) return;
      src.usedThisTurn.push(e);
    }
    const n = (v: number) => (v === -1 ? Math.max(x, 2) : v);

    switch (e.kind) {
      case 'ramp': {
        const basics = p.library.filter((c) => c.isBasic && c.land);
        for (let i = 0; i < e.lands + e.toHand && basics.length; i++) {
          const pick = this.pickBasic(p, basics);
          basics.splice(basics.indexOf(pick), 1);
          p.library.splice(p.library.indexOf(pick), 1);
          if (i < e.lands) this.putLand(p, pick, pick.land!, e.tapped);
          else p.hand.push(pick);
        }
        this.rng.shuffle(p.library);
        break;
      }
      case 'treasure':
        p.treasures += e.n;
        break;
      case 'extraLand': {
        const land = p.hand.find((c) => c.isLand && c.land);
        if (land) {
          p.hand.splice(p.hand.indexOf(land), 1);
          this.putLand(p, land, land.land!);
        }
        break;
      }
      case 'draw':
        this.draw(p, n(e.n));
        break;
      case 'removal':
        this.resolveRemoval(p, e, x);
        break;
      case 'wipe':
        this.resolveWipe(p, e, x);
        break;
      case 'tokens': {
        const count = Math.min(n(e.n), 10);
        for (let i = 0; i < count; i++) {
          const token = this.makePerm(p, tokenCard(e.power, e.toughness, e.keywords), true);
          p.battlefield.push(token);
          this.fireCreatureEnters(p, token);
        }
        if (count) this.say(`${this.name(p)} makes ${count} ${e.power}/${e.toughness} token${count > 1 ? 's' : ''}.`);
        break;
      }
      case 'overrun':
        for (const perm of p.battlefield) {
          if (!perm.card.isCreature) continue;
          perm.tempP += e.p;
          perm.tempT += e.t;
          if (e.trample) perm.tempKw.push('trample');
        }
        break;
      case 'drain': {
        const amount = n(e.n);
        let total = 0;
        for (const o of this.opponents(p)) {
          this.loseLife(o, amount, p, 'noncombat');
          total += amount;
        }
        p.life += e.gain === -1 ? total : e.gain;
        this.say(`${this.name(p)} drains each opponent for ${amount}.`);
        break;
      }
      case 'damagePlayer': {
        const amount = n(e.n);
        const target = this.pickPlayerToBurn(p, amount);
        if (target) {
          this.loseLife(target, amount, p, 'noncombat');
          this.say(`${this.name(p)} hits ${this.name(target)} for ${amount}.`);
        }
        break;
      }
      case 'gainLife':
        p.life += n(e.n);
        break;
      case 'tutor': {
        const pick = this.pickTutorTarget(p);
        if (pick) {
          p.library.splice(p.library.indexOf(pick), 1);
          p.hand.push(pick);
          this.rng.shuffle(p.library);
        }
        break;
      }
      case 'recursion': {
        for (let i = 0; i < n(e.n); i++) {
          const creatures = p.graveyard.filter((c) => c.isCreature);
          if (!creatures.length) break;
          const best = creatures.reduce((a, b) => (b.value > a.value ? b : a));
          p.graveyard.splice(p.graveyard.indexOf(best), 1);
          if (e.toBattlefield) {
            this.say(`${this.name(p)} reanimates ${best.name}.`);
            this.resolveSpell(p, best, 0, false);
          } else {
            p.hand.push(best);
          }
        }
        break;
      }
      case 'counters': {
        const amount = n(e.n);
        if (e.all) {
          for (const perm of p.battlefield) if (perm.card.isCreature) perm.counters += amount;
        } else {
          const target = src && src.card.isCreature ? src : this.bestCreature(p);
          if (target) target.counters += amount;
        }
        break;
      }
      // Static or reactive effects: nothing happens on resolution.
      default:
        break;
    }
  }

  private pickBasic(p: Player, basics: SimCard[]): SimCard {
    // Fetch the color we have the fewest sources of.
    const counts = new Map<Mana, number>();
    for (const perm of p.battlefield) {
      const prod = perm.landInfo?.produces;
      if (!prod) continue;
      for (const m of prod === 'any' ? ALL_COLORS : prod) counts.set(m, (counts.get(m) ?? 0) + 1);
    }
    let best = basics[0];
    let bestCount = Infinity;
    for (const b of basics) {
      const prod = b.land!.produces;
      const m = prod === 'any' ? 'C' : prod[0];
      const c = counts.get(m) ?? 0;
      if (c < bestCount) {
        best = b;
        bestCount = c;
      }
    }
    return best;
  }

  private pickTutorTarget(p: Player): SimCard | null {
    if (!p.library.length) return null;
    const needLand = this.landCount(p) < 4 && !p.hand.some((c) => c.isLand);
    let best: SimCard | null = null;
    for (const c of p.library) {
      if (needLand ? !c.isLand : c.isLand) continue;
      if (!best || c.value > best.value) best = c;
    }
    return best ?? p.library[0];
  }

  private pickPlayerToBurn(p: Player, amount: number): Player | null {
    const opps = this.opponents(p);
    if (!opps.length) return null;
    const killable = opps.filter((o) => o.life <= amount);
    if (killable.length) return killable[0];
    return opps.reduce((a, b) => (this.boardThreat(b, false) - b.life * 0.2 > this.boardThreat(a, false) - a.life * 0.2 ? b : a));
  }

  private loseLife(p: Player, amount: number, source: Player | null, kind: LossReason) {
    p.life -= amount;
    if (source && source !== p) {
      p.lastHitBy = source.seat;
      p.lastHitKind = kind;
    }
  }

  // -------------------------------------------------------------------------
  // Removal
  // -------------------------------------------------------------------------

  /** How dangerous a permanent is to its opponents. */
  threat(perm: Perm): number {
    const card = perm.card;
    let t = 0;
    if (card.isCreature) {
      const power = this.power(perm);
      const evasive = this.hasKw(perm, 'flying') || this.hasKw(perm, 'unblockable') || this.hasKw(perm, 'menace');
      t += power * (evasive ? 1.5 : 1) + this.toughness(perm) * 0.2;
      if (this.hasKw(perm, 'double strike')) t += power;
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

  private chooseRemovalTarget(p: Player, e: Extract<Effect, { kind: 'removal' }>, x: number): { perm: Perm; threat: number } | null {
    if (e.mode === 'edict') {
      const opps = this.opponents(p).filter((o) => o.battlefield.some((q) => q.card.isCreature));
      if (!opps.length) return null;
      return { perm: opps[0].battlefield.find((q) => q.card.isCreature)!, threat: 3 };
    }
    const amount = e.amount === -1 ? Math.max(x, 1) : e.amount;
    const fighter = e.mode === 'fight' ? this.bestCreature(p) : null;
    if (e.mode === 'fight' && !fighter) return null;

    let best: Perm | null = null;
    let bestThreat = 0;
    const minimum = 3 + this.round * 0.2;
    for (const o of this.opponents(p)) {
      const leaderBonus = this.boardThreat(o, false) > 15 ? 1.2 : 1;
      for (const perm of o.battlefield) {
        if (perm.landInfo) continue;
        if (!targetMatches(e.target, perm.card)) continue;
        if (this.hasKw(perm, 'hexproof') || this.hasKw(perm, 'shroud')) continue;
        if (e.mode === 'destroy' && this.hasKw(perm, 'indestructible')) continue;
        if (e.mode === 'damage' && (!perm.card.isCreature || amount < this.toughness(perm) - perm.damage)) continue;
        if (e.mode === 'fight' && (!perm.card.isCreature || this.power(fighter!) < this.toughness(perm))) continue;
        let t = this.threat(perm) * leaderBonus;
        if (this.hasKw(perm, 'ward')) t *= 0.6;
        if (e.mode === 'bounce' && perm.token) t *= 1.3;
        if (t > bestThreat) {
          best = perm;
          bestThreat = t;
        }
      }
    }
    return best && bestThreat >= minimum ? { perm: best, threat: bestThreat } : null;
  }

  private resolveRemoval(p: Player, e: Extract<Effect, { kind: 'removal' }>, x: number) {
    if (e.mode === 'edict') {
      // Pick the opponent whose best creature is scariest and who has the fewest creatures.
      let bestOpp: Player | null = null;
      let bestScore = 0;
      for (const o of this.opponents(p)) {
        const creatures = o.battlefield.filter((q) => q.card.isCreature);
        if (!creatures.length) continue;
        const score = Math.max(...creatures.map((c) => this.threat(c))) / creatures.length;
        if (score > bestScore) {
          bestOpp = o;
          bestScore = score;
        }
      }
      if (!bestOpp) return;
      const creatures = bestOpp.battlefield.filter((q) => q.card.isCreature);
      const victim = creatures.reduce((a, b) => (this.threat(b) < this.threat(a) ? b : a));
      this.say(`${this.name(bestOpp)} sacrifices ${victim.card.name}.`);
      this.destroy(victim, false);
      return;
    }

    const choice = this.chooseRemovalTarget(p, e, x);
    if (!choice) return;
    const target = choice.perm;
    const owner = this.players[target.seat];
    if (this.tryProtect(owner, target)) return;

    this.say(`${this.name(p)} ${e.mode === 'fight' ? 'fights' : e.mode + 's'} ${target.card.name} (${this.name(owner)}).`);
    switch (e.mode) {
      case 'destroy': this.destroy(target, false); break;
      case 'exile': this.removePerm(target, 'exile'); break;
      case 'bounce': this.removePerm(target, 'hand'); break;
      case 'damage':
        target.damage += e.amount === -1 ? Math.max(x, 1) : e.amount;
        break;
      case 'fight': {
        const fighter = this.bestCreature(p);
        if (fighter) target.damage += this.power(fighter);
        break;
      }
    }
    this.checkCreatureDeaths();
  }

  private tryProtect(owner: Player, target: Perm): boolean {
    if (this.threat(target) < 5) return false;
    const spell = owner.hand.find((c) => (c.isInstant || c.keywords.includes('flash')) && c.effects.some((e) => e.kind === 'protect' || (e.kind === 'pump' && e.protect)));
    if (!spell || !this.canAfford(owner, spell)) return false;
    this.pay(owner, spell, false, 0);
    owner.hand.splice(owner.hand.indexOf(spell), 1);
    owner.graveyard.push(spell);
    this.fireCastTriggers(owner, spell);
    this.say(`${this.name(owner)} protects ${target.card.name} with ${spell.name}.`);
    return true;
  }

  private wipeIsGood(p: Player, e: Extract<Effect, { kind: 'wipe' }>, x: number): boolean {
    const creaturesOnly = e.target === 'creatures';
    const affects = (perm: Perm) => {
      if (perm.landInfo) return false;
      if (creaturesOnly && !perm.card.isCreature) return false;
      if (e.mode === 'damage') return perm.card.isCreature && (e.amount === -1 ? x : e.amount) >= this.toughness(perm);
      if (e.mode === 'destroy' && this.hasKw(perm, 'indestructible')) return false;
      return true;
    };
    let mine = 0;
    if (!e.oneSided) for (const perm of p.battlefield) if (affects(perm)) mine += this.threat(perm);
    let theirs = 0;
    let incoming = 0;
    for (const o of this.opponents(p)) {
      for (const perm of o.battlefield) {
        if (affects(perm)) theirs += this.threat(perm);
        if (perm.card.isCreature) incoming += this.power(perm);
      }
    }
    if (e.oneSided) return theirs >= 6;
    if (incoming >= p.life && theirs > mine) return true;
    return theirs >= 10 && theirs >= mine * 1.6 + 4;
  }

  private resolveWipe(p: Player, e: Extract<Effect, { kind: 'wipe' }>, x: number) {
    const amount = e.amount === -1 ? x : e.amount;
    this.say(`${this.name(p)} wipes the board.`);
    for (const q of this.alivePlayers()) {
      if (e.oneSided && q === p) continue;
      for (const perm of [...q.battlefield]) {
        if (perm.landInfo) continue;
        if (e.target === 'creatures' && !perm.card.isCreature) continue;
        switch (e.mode) {
          case 'exile': this.removePerm(perm, 'exile'); break;
          case 'bounce': this.removePerm(perm, 'hand'); break;
          case 'damage': if (perm.card.isCreature) perm.damage += amount; break;
          default: this.destroy(perm, false);
        }
      }
    }
    this.checkCreatureDeaths();
  }

  // -------------------------------------------------------------------------
  // Creatures: stats, equipment, death
  // -------------------------------------------------------------------------

  private anthemBonus(seat: number): { p: number; t: number } {
    let p = 0;
    let t = 0;
    for (const perm of this.players[seat].battlefield) {
      for (const e of perm.card.effects) {
        if (e.kind === 'anthem') {
          p += e.p;
          t += e.t;
        }
      }
    }
    return { p, t };
  }

  power(perm: Perm): number {
    let p = perm.card.power + perm.counters + perm.tempP + this.anthemBonus(perm.seat).p;
    for (const eq of this.attachments(perm)) for (const e of eq.card.effects) if (e.kind === 'equip') p += e.p;
    return Math.max(0, p);
  }

  toughness(perm: Perm): number {
    let t = perm.card.toughness + perm.counters + perm.tempT + this.anthemBonus(perm.seat).t;
    for (const eq of this.attachments(perm)) for (const e of eq.card.effects) if (e.kind === 'equip') t += e.t;
    return t;
  }

  hasKw(perm: Perm, kw: string): boolean {
    if (perm.card.keywords.includes(kw) || perm.tempKw.includes(kw)) return true;
    for (const eq of this.attachments(perm)) {
      for (const e of eq.card.effects) if (e.kind === 'equip' && e.keywords.includes(kw)) return true;
    }
    return false;
  }

  private attachments(perm: Perm): Perm[] {
    const out: Perm[] = [];
    for (const q of this.players[perm.seat].battlefield) if (q.attachedTo === perm.id) out.push(q);
    return out;
  }

  private bestCreature(p: Player): Perm | null {
    let best: Perm | null = null;
    for (const perm of p.battlefield) {
      if (!perm.card.isCreature) continue;
      if (!best || this.power(perm) > this.power(best)) best = perm;
    }
    return best;
  }

  private attachEquipment(p: Player, equipment: Perm) {
    const grantsHaste = equipment.card.effects.some((e) => e.kind === 'equip' && e.keywords.includes('haste'));
    let best: Perm | null = null;
    let bestScore = -1;
    for (const perm of p.battlefield) {
      if (!perm.card.isCreature) continue;
      let score = this.power(perm) + (perm.isCommander ? 2 : 0);
      if (perm.sick && !grantsHaste) score -= 3;
      if (score > bestScore) {
        best = perm;
        bestScore = score;
      }
    }
    equipment.attachedTo = best ? best.id : null;
  }

  private checkCreatureDeaths() {
    for (const q of this.players) {
      for (const perm of [...q.battlefield]) {
        if (!perm.card.isCreature) continue;
        const toughness = this.toughness(perm);
        const lethal = perm.damage >= toughness || perm.deathtouched;
        if (toughness <= 0 || (lethal && !this.hasKw(perm, 'indestructible'))) this.destroy(perm, true);
      }
    }
  }

  /** Destroy a permanent (respects indestructible unless `force`). */
  private destroy(perm: Perm, force: boolean) {
    if (!force && this.hasKw(perm, 'indestructible')) return;
    this.removePerm(perm, 'graveyard');
  }

  private removePerm(perm: Perm, to: 'graveyard' | 'exile' | 'hand') {
    const owner = this.players[perm.seat];
    const idx = owner.battlefield.indexOf(perm);
    if (idx === -1) return;
    owner.battlefield.splice(idx, 1);

    // Equipment falls off; auras go to the graveyard.
    for (const q of [...owner.battlefield]) {
      if (q.attachedTo !== perm.id) continue;
      q.attachedTo = null;
      if (q.card.effects.some((e) => e.kind === 'equip' && e.aura)) this.removePerm(q, 'graveyard');
    }

    if (!perm.token) {
      if (perm.isCommander && to !== 'hand') owner.commandZone.push(perm.card);
      else if (to === 'graveyard') owner.graveyard.push(perm.card);
      else if (to === 'hand') owner.hand.push(perm.card);
    }

    if (perm.card.isCreature && to === 'graveyard' && owner.alive) {
      for (const e of perm.card.effects) if (e.when === 'creatureDies' && e.scope === 'self') this.resolveEffect(owner, e, null, 0);
      for (const q of [...owner.battlefield]) {
        for (const e of q.card.effects) if (e.when === 'creatureDies' && e.scope !== 'self') this.resolveEffect(owner, e, q, 0);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Combat
  // -------------------------------------------------------------------------

  private creaturesThatCanAttack(p: Player): Perm[] {
    return p.battlefield.filter(
      (perm) => perm.card.isCreature && !perm.tapped && (!perm.sick || this.hasKw(perm, 'haste')) && !this.hasKw(perm, 'defender') && this.power(perm) > 0,
    );
  }

  canBlock(blocker: Perm, attacker: Perm): boolean {
    if (!blocker.card.isCreature || blocker.tapped) return false;
    if (this.hasKw(attacker, 'unblockable')) return false;
    if (this.hasKw(attacker, 'flying') && !this.hasKw(blocker, 'flying') && !this.hasKw(blocker, 'reach')) return false;
    return true;
  }

  /** Damage `a` deals in one combat (double strike counts twice). */
  private hitDamage(a: Perm): number {
    return this.power(a) * (this.hasKw(a, 'double strike') ? 2 : 1);
  }

  kills(attacker: Perm, defender: Perm): boolean {
    return this.hasKw(attacker, 'deathtouch') ? this.power(attacker) > 0 : this.hitDamage(attacker) >= this.toughness(defender) - defender.damage;
  }

  survives(creature: Perm, from: Perm): boolean {
    if (this.hasKw(creature, 'indestructible')) return true;
    if (this.hasKw(creature, 'first strike') && !this.hasKw(from, 'first strike') && !this.hasKw(from, 'double strike') && this.kills(creature, from)) return true;
    return !this.kills(from, creature);
  }

  private chooseDefender(p: Player, attackers: Perm[]): Player | null {
    const opps = this.opponents(p);
    if (!opps.length) return null;
    let best: Player | null = null;
    let bestScore = -Infinity;
    for (const o of opps) {
      const blockers = o.battlefield.filter((b) => b.card.isCreature && !b.tapped);
      let unblockable = 0;
      let total = 0;
      for (const a of attackers) {
        total += this.hitDamage(a);
        if (!blockers.some((b) => this.canBlock(b, a))) unblockable += this.hitDamage(a);
      }
      const score = this.attackScore(o, blockers, unblockable, total) + this.rng.next() * 8;
      if (score > bestScore) {
        best = o;
        bestScore = score;
      }
    }
    return best;
  }

  private combat(p: Player) {
    for (const eq of p.battlefield) {
      if (eq.card.effects.some((e) => e.kind === 'equip' && !e.aura)) this.attachEquipment(p, eq);
    }

    let candidates = this.creaturesThatCanAttack(p);
    if (!candidates.length) return;
    const main = this.chooseDefender(p, candidates);
    if (!main) return;

    // Team pump before attacking, if we have one and a real attack.
    if (candidates.length >= 3) {
      const overrun = p.hand.find((c) => c.effects.some((e) => e.kind === 'overrun'));
      if (overrun && this.canAfford(p, overrun)) this.castSpell(p, overrun, false, 0);
    }

    // Keep blockers home if the table could kill us on the crack-back.
    let crackBack = 0;
    for (const o of this.opponents(p)) {
      let power = 0;
      for (const perm of o.battlefield) if (perm.card.isCreature) power += this.hitDamage(perm);
      crackBack = Math.max(crackBack, power);
    }
    if (crackBack >= p.life) {
      const keep = candidates.filter((c) => !this.hasKw(c, 'vigilance')).sort((a, b) => this.toughness(b) - this.toughness(a)).slice(0, 2);
      candidates = candidates.filter((c) => !keep.includes(c));
    }

    // Each creature attacks the main target if that's sensible, otherwise any
    // other opponent it can hit safely.
    const totalDamage = candidates.reduce((s, a) => s + this.hitDamage(a), 0);
    const order = [main, ...this.opponents(p).filter((o) => o !== main).sort((a, b) => a.life - b.life)];
    const assignment = new Map<Player, Perm[]>();
    for (const a of candidates) {
      for (const o of order) {
        const isMain = o === main;
        const blockers = o.battlefield.filter((b) => b.card.isCreature && !b.tapped && this.canBlock(b, a));
        // Lethal-ish alpha strike, or so many attackers that most get through.
        const alphaLethal = isMain && (totalDamage - blockers.length * 3 >= o.life || candidates.length >= blockers.length + 2);
        const badBlock = blockers.some((b) => !this.survives(a, b) && this.survives(b, a));
        const trade = blockers.some((b) => !this.survives(a, b));
        let attack = !badBlock || alphaLethal;
        if (!attack && isMain && !trade) attack = true;
        if (!attack && isMain && a.token && this.rng.chance(0.4 * p.aggression)) attack = true;
        if (!attack && isMain && this.rng.chance(0.1 * p.aggression)) attack = true;
        if (attack) {
          if (!assignment.has(o)) assignment.set(o, []);
          assignment.get(o)!.push(a);
          break;
        }
      }
    }
    const attackers = [...assignment.values()].flat();
    if (!attackers.length) return;

    for (const a of attackers) if (!this.hasKw(a, 'vigilance')) a.tapped = true;
    for (const d of assignment.keys()) d.attackedBy.set(p.seat, this.round);
    for (const [d, as] of assignment) {
      this.say(`${this.name(p)} attacks ${this.name(d)} with ${as.map((a) => `${a.card.name} ${this.power(a)}/${this.toughness(a)}`).join(', ')}.`);
    }

    for (const a of attackers) {
      for (const e of a.card.effects) if (e.when === 'attack' && e.scope === 'self') this.resolveEffect(p, e, a, 0);
      for (const eq of this.attachments(a)) for (const e of eq.card.effects) if (e.when === 'attack' && e.scope === 'self') this.resolveEffect(p, e, eq, 0);
    }
    for (const perm of [...p.battlefield]) {
      for (const e of perm.card.effects) {
        if (e.when !== 'attack') continue;
        if (e.scope === 'oneOrMore') this.resolveEffect(p, e, perm, 0);
        if (e.scope === 'any') for (let i = 0; i < attackers.length; i++) this.resolveEffect(p, e, perm, 0);
      }
    }

    const hitPlayer = new Set<Perm>();
    for (const [d, as] of assignment) {
      if (!d.alive) continue;
      const lifeBefore = d.life;
      const living = as.filter((a) => p.battlefield.includes(a));
      const blocks = this.declareBlocks(d, living);
      this.useCombatTricks(p, d, living, blocks);
      for (const a of this.resolveCombatDamage(p, d, living, blocks)) hitPlayer.add(a);
      if (d.life !== lifeBefore) this.say(`${this.name(d)} takes ${lifeBefore - d.life} (life ${d.life}).`);
    }
    this.combatDamageTriggers(p, hitPlayer);
  }

  private declareBlocks(d: Player, attackers: Perm[]): Map<Perm, Perm[]> {
    const blocks = new Map<Perm, Perm[]>();
    const available = d.battlefield.filter((b) => b.card.isCreature && !b.tapped);
    const take = (b: Perm) => available.splice(available.indexOf(b), 1);
    const sorted = [...attackers].sort((a, b) => this.hitDamage(b) - this.hitDamage(a));

    // 1. Blocks where our blocker kills the attacker and survives.
    for (const a of sorted) {
      if (this.hasKw(a, 'menace')) continue;
      const good = available.filter((b) => this.canBlock(b, a) && this.kills(b, a) && this.survives(b, a));
      if (good.length) {
        const b = good.reduce((x, y) => (this.threat(y) < this.threat(x) ? y : x));
        blocks.set(a, [b]);
        take(b);
      }
    }
    // 2. Trades that favour us.
    for (const a of sorted) {
      if (blocks.has(a) || this.hasKw(a, 'menace')) continue;
      const trade = available.filter((b) => this.canBlock(b, a) && this.kills(b, a) && this.threat(b) < this.threat(a));
      if (trade.length) {
        const b = trade.reduce((x, y) => (this.threat(y) < this.threat(x) ? y : x));
        blocks.set(a, [b]);
        take(b);
      }
    }
    // 3. Chump-block if the unblocked damage would kill us (or 21 commander damage).
    const incoming = () => {
      let total = 0;
      let cmdLethal = false;
      for (const a of attackers) {
        if (blocks.has(a)) {
          if (this.hasKw(a, 'trample')) total += Math.max(0, this.hitDamage(a) - blocks.get(a)!.reduce((s, b) => s + this.toughness(b), 0));
          continue;
        }
        total += this.hitDamage(a);
        if (a.isCommander) {
          const key = `${a.seat}:${a.card.name}`;
          if ((d.commanderDamage.get(key) ?? 0) + this.hitDamage(a) >= 21) cmdLethal = true;
        }
      }
      return { total, cmdLethal };
    };
    for (const a of sorted) {
      const { total, cmdLethal } = incoming();
      if (total < d.life && !cmdLethal) break;
      if (blocks.has(a)) continue;
      const need = this.hasKw(a, 'menace') ? 2 : 1;
      const chumps = available.filter((b) => this.canBlock(b, a)).sort((x, y) => this.threat(x) - this.threat(y)).slice(0, need);
      if (chumps.length < need) continue;
      blocks.set(a, chumps);
      chumps.forEach(take);
    }
    if (blocks.size) this.say(`${this.name(d)} blocks: ${[...blocks].map(([a, bs]) => `${bs.map((b) => b.card.name).join('+')} → ${a.card.name}`).join(', ')}.`);
    return blocks;
  }

  private useCombatTricks(p: Player, d: Player, attackers: Perm[], blocks: Map<Perm, Perm[]>) {
    const tricks = () => p.hand.filter((c) => c.effects.some((e) => e.kind === 'pump') && this.canAfford(p, c));
    for (const [a, bs] of blocks) {
      const trick = tricks()[0];
      if (!trick) return;
      const pump = trick.effects.find((e) => e.kind === 'pump') as Extract<Effect, { kind: 'pump' }>;
      const dies = bs.some((b) => !this.survives(a, b));
      const killsAll = bs.every((b) => this.kills(a, b));
      const pumpKills = bs.every((b) => this.power(a) + (pump.p === -1 ? 3 : pump.p) >= this.toughness(b) - b.damage);
      if ((dies && this.threat(a) >= 4) || (!killsAll && pumpKills && bs.length === 1)) {
        this.castTrick(p, trick, a, pump);
      }
    }
    // Pump an unblocked attacker for lethal.
    const unblocked = attackers.filter((a) => !blocks.has(a) && p.battlefield.includes(a));
    const damage = unblocked.reduce((s, a) => s + this.hitDamage(a), 0);
    const trick = tricks()[0];
    if (trick && unblocked.length) {
      const pump = trick.effects.find((e) => e.kind === 'pump') as Extract<Effect, { kind: 'pump' }>;
      if (damage < d.life && damage + (pump.p === -1 ? 3 : pump.p) >= d.life) this.castTrick(p, trick, unblocked[0], pump);
    }
  }

  private castTrick(p: Player, trick: SimCard, target: Perm, pump: Extract<Effect, { kind: 'pump' }>) {
    if (!this.pay(p, trick, false, 0)) return;
    p.hand.splice(p.hand.indexOf(trick), 1);
    p.graveyard.push(trick);
    this.fireCastTriggers(p, trick);
    target.tempP += pump.p === -1 ? 3 : pump.p;
    target.tempT += pump.t === -1 ? 3 : pump.t;
    if (pump.protect) target.tempKw.push('indestructible');
    this.say(`${this.name(p)} pumps ${target.card.name} with ${trick.name}.`);
  }

  /** Deal combat damage for one defending player. Returns attackers that hit the player. */
  private resolveCombatDamage(p: Player, d: Player, attackers: Perm[], blocks: Map<Perm, Perm[]>): Set<Perm> {
    const dealtToPlayer = new Set<Perm>();
    const isFirst = (c: Perm) => this.hasKw(c, 'first strike') || this.hasKw(c, 'double strike');
    const isRegular = (c: Perm) => !this.hasKw(c, 'first strike') || this.hasKw(c, 'double strike');

    for (const step of ['first', 'regular'] as const) {
      const strikes = step === 'first' ? isFirst : isRegular;
      for (const a of attackers) {
        const bs = (blocks.get(a) ?? []).filter((b) => d.battlefield.includes(b));
        if (p.battlefield.includes(a) && strikes(a)) {
          const power = this.power(a);
          if (!blocks.has(a)) {
            this.combatDamageToPlayer(p, d, a, power);
            if (power > 0) dealtToPlayer.add(a);
          } else {
            // Assign lethal damage to each blocker in turn; trample sends the rest to the player.
            let left = power;
            const deathtouch = this.hasKw(a, 'deathtouch');
            for (const b of bs) {
              const needed = deathtouch ? 1 : Math.max(0, this.toughness(b) - b.damage);
              const dealt = Math.min(left, needed);
              b.damage += dealt;
              if (deathtouch && dealt > 0) b.deathtouched = true;
              left -= dealt;
            }
            if (left > 0 && this.hasKw(a, 'trample')) {
              this.combatDamageToPlayer(p, d, a, left);
              dealtToPlayer.add(a);
              if (this.hasKw(a, 'lifelink')) p.life += power - left;
            } else {
              if (left > 0 && bs.length) bs[bs.length - 1].damage += left;
              if (this.hasKw(a, 'lifelink')) p.life += power;
            }
          }
        }
        // Blockers strike back.
        for (const b of bs) {
          if (!strikes(b) || !p.battlefield.includes(a)) continue;
          const power = this.power(b);
          a.damage += power;
          if (this.hasKw(b, 'deathtouch') && power > 0) a.deathtouched = true;
          if (this.hasKw(b, 'lifelink')) d.life += power;
        }
      }
      this.checkCreatureDeaths();
    }
    return dealtToPlayer;
  }

  private combatDamageTriggers(p: Player, hitPlayer: Set<Perm>) {
    if (!hitPlayer.size || !p.alive) return;
    for (const a of hitPlayer) {
      if (!p.battlefield.includes(a)) continue;
      for (const e of a.card.effects) if (e.when === 'combatDamage' && e.scope === 'self') this.resolveEffect(p, e, a, 0);
      for (const eq of this.attachments(a)) for (const e of eq.card.effects) if (e.when === 'combatDamage' && e.scope === 'self') this.resolveEffect(p, e, eq, 0);
    }
    for (const perm of [...p.battlefield]) {
      for (const e of perm.card.effects) {
        if (e.when !== 'combatDamage') continue;
        if (e.scope === 'oneOrMore') this.resolveEffect(p, e, perm, 0);
        if (e.scope === 'any') for (let i = 0; i < hitPlayer.size; i++) this.resolveEffect(p, e, perm, 0);
      }
    }
  }

  private combatDamageToPlayer(p: Player, d: Player, a: Perm, amount: number) {
    if (amount <= 0) return;
    this.loseLife(d, amount, p, 'combat');
    if (this.hasKw(a, 'lifelink')) p.life += amount;
    if (a.isCommander) {
      const key = `${a.seat}:${a.card.name}`;
      const total = (d.commanderDamage.get(key) ?? 0) + amount;
      d.commanderDamage.set(key, total);
    }
  }

  // -------------------------------------------------------------------------
  // Helpers used by the Playstyle quiz's board states
  // -------------------------------------------------------------------------

  /** The default AI's (noise-free) preference for attacking `o`. */
  private attackScore(o: Player, blockers: Perm[], unblockable: number, total: number): number {
    let score = 0;
    if (unblockable >= o.life) score += 100;
    else if (total - blockers.length * 2 >= o.life) score += 25;
    score += this.boardThreat(o, false) * 0.4;
    score += (40 - o.life) * 0.4;
    score -= blockers.reduce((s, b) => s + this.power(b), 0) * 0.3;
    return score;
  }

  /** Public views for the quiz. */
  canAttackWith(p: Player): Perm[] {
    return this.creaturesThatCanAttack(p);
  }

  // -------------------------------------------------------------------------
  // State checks and elimination
  // -------------------------------------------------------------------------

  /** Board strength of a player, used for politics and wipe decisions. */
  boardThreat(p: Player, creaturesOnly: boolean): number {
    let t = 0;
    for (const perm of p.battlefield) {
      if (perm.landInfo) continue;
      if (creaturesOnly && !perm.card.isCreature) continue;
      t += this.threat(perm);
    }
    return t;
  }

  private checkState() {
    this.checkCreatureDeaths();
    const dying: { p: Player; reason: LossReason }[] = [];
    for (const p of this.players) {
      if (!p.alive) continue;
      let reason: LossReason | null = null;
      if (p.life <= 0) reason = p.lastHitKind;
      for (const dmg of p.commanderDamage.values()) if (dmg >= 21) reason = 'commander';
      if (p.drewFromEmpty) reason = 'decked';
      if (reason) dying.push({ p, reason });
    }
    if (!dying.length) return;
    const aliveBefore = this.alivePlayers().length;
    for (const { p, reason } of dying) {
      p.alive = false;
      // Everyone left in the game finished ahead; simultaneous losers share the place.
      this.placements[p.seat] = aliveBefore - dying.length + 1;
      const killer = reason === 'decked' ? null : p.lastHitBy;
      this.eliminations.push({ seat: p.seat, round: this.round, reason, killer });
      this.say(`${this.name(p)} is eliminated (${reason}${killer !== null ? ` by ${this.name(this.players[killer])}` : ''}).`);
      p.battlefield = [];
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function matchesFilter(card: SimCard, filter: CastFilter): boolean {
  switch (filter) {
    case 'any': return true;
    case 'noncreature': return !card.isCreature;
    case 'creature': return card.isCreature;
    case 'instantSorcery': return card.isInstant || card.isSorcery;
    case 'artifact': return card.isArtifact;
    case 'enchantment': return card.isEnchantment;
  }
}

function counterMatches(target: 'any' | 'noncreature' | 'creature', card: SimCard): boolean {
  if (target === 'any') return true;
  return target === 'creature' ? card.isCreature : !card.isCreature;
}

function targetMatches(target: string, card: SimCard): boolean {
  switch (target) {
    case 'creature': return card.isCreature;
    case 'permanent': return true;
    case 'noncreature': return !card.isCreature;
    case 'artifactEnchantment': return card.isArtifact || card.isEnchantment;
    case 'planeswalker': return card.isPlaneswalker;
    default: return false;
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
      isLand: false,
      isCreature: true,
      isArtifact: false,
      isEnchantment: false,
      isPlaneswalker: false,
      isInstant: false,
      isSorcery: false,
      isLegendary: false,
      isBasic: false,
      power,
      toughness,
      keywords,
      effects: [],
      value: power + toughness * 0.5,
      modeled: true,
      notes: [],
    };
    tokenCache.set(key, card);
  }
  return card;
}

/** Convenience: play one game and return the result. */
export function playGame(decks: SimDeck[], seed: number, opts: GameOptions = {}): { result: GameResult; log: string[] | null } {
  const game = new Game(decks, seed, opts);
  const result = game.run();
  return { result, log: game.log };
}
