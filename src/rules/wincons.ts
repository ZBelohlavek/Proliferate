// Ways to win that don't go through combat: alternative win conditions printed
// on cards, and well-known two-card combos that win on the spot.
//
// These are looked up by card name, so they work for decks that were imported
// before this file existed (decks are stored already classified, without their
// rules text). The engine (game.ts) checks them; the bot (bot.ts) uses the same
// tables to recognise what it is building towards and what to stop.

import { isFood } from '../engine/artifactTokens';
import type { SimCard } from '../engine/types';
import { SPELLBOOK_COMBOS } from './combosSpellbook';
import type { Game } from './game';
import type { Perm, PlayerState } from './types';

// ---------------------------------------------------------------------------
// Alternative win conditions
// ---------------------------------------------------------------------------

/** Artifacts a player controls, counting Treasure tokens. */
export function artifactCount(p: PlayerState): number {
  return p.treasures + p.battlefield.filter((q) => q.card.isArtifact).length;
}

/**
 * "At the beginning of your upkeep, if ..., you win the game." Keyed by card
 * name; each returns true when its controller wins now.
 */
export const UPKEEP_WINS: Record<string, (p: PlayerState, perm: Perm) => boolean> = {
  'Revel in Riches': (p) => p.treasures >= 10,
  Triskaidekaphile: (p) => p.hand.length === 13,
  'Hellkite Tyrant': (p) => artifactCount(p) >= 20,
  'Knuckles the Echidna': (p) => artifactCount(p) >= 30,
  // "You may put a charge counter on it each upkeep; with twenty or more, you win." Counted on the permanent.
  'Darksteel Reactor': (_p, perm) => perm.counters >= 20,
};

/** Permanents that put a counter on themselves at the beginning of your upkeep (before the win check). */
export const UPKEEP_COUNTERS = new Set(['Darksteel Reactor']);

// ---------------------------------------------------------------------------
// Combos
// ---------------------------------------------------------------------------

/**
 * How a loop finishes: every opponent drains or is milled out, `draw` wins on an empty library,
 * `win` ends the game outright (an alternative win, endless turns, an endless hasty army),
 * `one` and `millOne` finish one opponent each turn.
 */
export type ComboKind = 'drain' | 'mill' | 'draw' | 'win' | 'one' | 'millOne';

/** A combo from Commander Spellbook, as generated into combosSpellbook.ts. */
export interface SpellbookCombo {
  id: string;
  name: string;
  /** `mana`: unlimited mana, which still needs a finisher on the board or in hand. */
  kind: ComboKind | 'mana';
  /** Each card and the zones it must be in (see combosSpellbook.ts). */
  pieces: { n: string; z: string; ready?: boolean }[];
  /** Mana the loop needs on top of having the pieces in place. */
  mana?: number;
  /** Generic pieces: 'persist' creature, 'extraTurn' spell in hand, 'cheapPermanent:N', 'zeroArtifact', 'manaRock'. */
  needs?: string[];
}

export interface Combo {
  name: string;
  /** One card from each group must be on its controller's battlefield (or, where `inHand` says so, in hand). */
  pieces: string[][];
  /** Groups (by index) whose card may be in hand or imprinted instead of on the battlefield. */
  inHand?: number[];
  /** How the loop finishes the opponents. Decided by `finisher` when it depends on the rest of the board. */
  kind: ComboKind;
  /** Extra condition beyond the pieces: what else must be in place. */
  ready?: (g: Game, p: PlayerState) => ComboKind | null;
  /** For each group, the zones its card has to be in (Spellbook letters); battlefield when absent. */
  zones?: string[];
  /** It makes unlimited mana or untaps, so it still needs something to spend them on. */
  needsFinisher?: boolean;
  /** It only draws endlessly, which wins with an empty-library win on the battlefield. */
  drawOnly?: boolean;
}

const LIFE_GAIN_HALF = ['Sanguine Bond', 'Vito, Thorn of the Dusk Rose'];
const LIFE_LOSS_HALF = ['Exquisite Blood', 'Bloodthirsty Conqueror'];

export const COMBOS: Combo[] = [
  // Gaining life makes an opponent lose life, which gains life, ... until every opponent is dead.
  { name: 'Sanguine Bond loop', pieces: [LIFE_GAIN_HALF, LIFE_LOSS_HALF], kind: 'drain' },
  // With three quest counters, every card milled drains 2, and every life lost mills that many.
  {
    name: 'Mindcrank + Bloodchief Ascension',
    pieces: [['Mindcrank'], ['Bloodchief Ascension']],
    kind: 'drain',
    ready: (_g, p) => (p.battlefield.some((q) => q.card.name === 'Bloodchief Ascension' && (q.charge ?? 0) >= 3) ? 'drain' : null),
  },
  // Dramatic Reversal on Isochron Scepter with three mana of rocks: infinite mana and untaps, which needs something to spend them on.
  {
    name: 'Isochron Scepter + Dramatic Reversal',
    pieces: [['Isochron Scepter'], ['Dramatic Reversal']],
    inHand: [1],
    kind: 'mill',
    needsFinisher: true,
    ready: (g, p) => {
      const scepter = p.battlefield.find((q) => q.card.name === 'Isochron Scepter' && g.imprinted.get(q.id)?.name === 'Dramatic Reversal');
      if (!scepter || scepter.tapped || g.availableMana(p) < 2) return null;
      return infiniteManaFinisher(p) && rockMana(p) >= 3 ? infiniteManaFinisher(p) : null;
    },
  },
];

/** The Spellbook combos, in the same shape as the hand-written ones. */
export const SPELLBOOK: Combo[] = SPELLBOOK_COMBOS.map((sc) => ({
  name: sc.name,
  pieces: sc.pieces.map((x) => [x.n]),
  zones: sc.pieces.map((x) => x.z),
  kind: sc.kind === 'mana' ? 'mill' : sc.kind,
  ready: (g, p) => spellbookReady(g, p, sc),
  ...(sc.kind === 'mana' ? { needsFinisher: true } : {}),
  ...(sc.kind === 'draw' ? { drawOnly: true } : {}),
}));

/** Cards in `p`'s library, hand, graveyard, exile or command zone, or on the battlefield, by name, for zone checks. */
function inZone(g: Game, p: PlayerState, name: string, zones: string, ready?: boolean): boolean {
  for (const z of zones) {
    switch (z) {
      case 'B':
        if (p.battlefield.some((q) => (q.card.name === name || q.unlocked?.name === name) && !(ready && q.card.isCreature && q.sick))) return true;
        break;
      case 'H': if (p.hand.some((c) => c.name === name)) return true; break;
      case 'C': if (p.commandZone.some((c) => c.name === name)) return true; break;
      case 'G': if (p.graveyard.some((c) => c.name === name)) return true; break;
      case 'E': if (p.exile.some((c) => c.name === name)) return true; break;
      case 'L': if (p.library.some((c) => c.name === name)) return true; break;
      case 'S':
        // Imprinted on an Isochron Scepter we control, or still in hand with a Scepter to imprint it on.
        if (p.battlefield.some((q) => q.card.name === 'Isochron Scepter' && g.imprinted.get(q.id)?.name === name)) return true;
        break;
    }
  }
  return false;
}

/**
 * Spellbook's "notable prerequisites" that the engine can check, by combo id. Prerequisites
 * that are nearly always met (a way to gain life, an opponent above Tree of Perdition's
 * toughness) are taken as met; ones it can't check are left out by the generator.
 */
const CONDITIONS: Record<string, (g: Game, p: PlayerState) => boolean> = {
  // Gev: an opponent has lost life this turn.
  '2034-5805--5': (g, p) => g.opponents(p).some((o) => g.lifeLostThisTurn[o.seat] > 0),
  '4050-5805--5': (g, p) => g.opponents(p).some((o) => g.lifeLostThisTurn[o.seat] > 0),
  '5147-5805--5': (g, p) => g.opponents(p).some((o) => g.lifeLostThisTurn[o.seat] > 0),
  // Bootleggers' Stash + Revel in Riches: ten lands and Treasures between them.
  '2429-3340': (g, p) => g.landCount(p) + p.treasures >= 10,
  // Axebane Guardian + High Alert: five creatures with defender.
  '3043-4896': (g, p) => p.battlefield.filter((q) => q.card.isCreature && g.hasKw(q, 'defender')).length >= 5,
  // Maze's End: ten different Gates between the library and the battlefield.
  '3063-3164': (_g, p) => new Set([...p.library, ...p.battlefield.map((q) => q.card)].filter((c) => /\bGate\b/.test(c.typeLine)).map((c) => c.name)).size >= 10,
  // Aetherflux Reservoir + Exquisite Blood: 51 life to start the loop.
  '3966-4740': (_g, p) => p.life >= 51,
  // Satya + Lightning Runner: six energy.
  '4918-5658': (_g, p) => p.energy >= 6,
  // Lightning Runner + Stone Idol Generator: five other creatures ready to attack.
  '4918-5723': (_g, p) => p.battlefield.filter((q) => q.card.isCreature && !q.sick).length >= 6,
  // Approach of the Second Sun + Windfall: nine cards in hand, or an opponent with seven.
  '553-790': (g, p) => p.hand.length >= 9 || g.opponents(p).some((o) => o.hand.length >= 7),
  // Jace, Cunning Castaway with five loyalty.
  '600-1124-1543': (_g, p) => p.battlefield.some((q) => q.card.name === 'Jace, Cunning Castaway' && (q.loyalty ?? 0) >= 5),
  '600-1543-4868': (_g, p) => p.battlefield.some((q) => q.card.name === 'Jace, Cunning Castaway' && (q.loyalty ?? 0) >= 5),
  // Peregrin Took and the Food engines: three Foods to start.
  '1575-4321': (_g, p) => p.battlefield.filter((q) => isFood(q.card)).length >= 3,
  '2590-4321': (_g, p) => p.battlefield.filter((q) => isFood(q.card)).length >= 3,
};

/** Proteus Staff on a creature of ours finds that same creature again, after showing (and letting us order) the whole library. */
export function canStackLibrary(p: PlayerState): boolean {
  return p.battlefield.some((q) => q.card.isCreature && !q.token) && !p.library.some((c) => c.isCreature);
}

/** The generic pieces a Spellbook combo asks for ("a persist creature", "an extra turn spell"). */
function hasNeed(p: PlayerState, need: string): boolean {
  if (need === 'persist') return p.battlefield.some((q) => q.card.isCreature && q.card.persist === 'persist');
  if (need === 'extraTurn') return p.hand.some((c) => c.effects.some((e) => e.kind === 'extraTurn'));
  if (need === 'zeroArtifact') return p.hand.some((c) => c.isArtifact && c.cmc === 0) || p.battlefield.some((q) => q.card.isArtifact && q.card.cmc === 0);
  if (need === 'manaRock') return p.battlefield.some((q) => !q.landInfo && q.card.isArtifact && q.card.effects.some((e) => e.kind === 'mana'));
  const cheap = /^cheapPermanent:(\d+)$/.exec(need);
  if (cheap) return p.hand.some((c) => !c.isInstant && !c.isSorcery && !c.isLand && c.cmc <= Number(cheap[1]) && !c.cost.pips.length);
  return false;
}

/**
 * Whether `p` can run a Spellbook combo now, and how it ends. A loop that casts something
 * from hand or needs mana is only started in its controller's own main phase with an empty stack.
 */
function spellbookReady(g: Game, p: PlayerState, sc: SpellbookCombo): ComboKind | null {
  if (!sc.pieces.every((x) => inZone(g, p, x.n, x.z, x.ready))) return null;
  if (CONDITIONS[sc.id] && !CONDITIONS[sc.id](g, p)) return null;
  if (sc.needs && !sc.needs.every((n) => hasNeed(p, n))) return null;
  // Proteus Staff loops stack the library, which needs a creature to aim it at and no other creature card in the library.
  if (sc.pieces.some((x) => x.n === 'Proteus Staff') && !canStackLibrary(p)) return null;
  const casts = sc.pieces.filter((x) => !x.z.includes('B') && x.z !== 'S');
  if (sc.mana || casts.length) {
    if (g.activeSeat !== p.seat || (g.step !== 'main1' && g.step !== 'main2') || g.stack.length) return null;
    const cost = sc.mana || casts.reduce((n, x) => n + (p.hand.find((c) => c.name === x.n)?.cmc ?? p.commandZone.find((c) => c.name === x.n)?.cmc ?? 0), 0);
    if (g.availableMana(p) < cost) return null;
  }
  if (sc.kind === 'mana') return infiniteManaFinisher(p);
  if (sc.kind === 'draw') return p.battlefield.some((q) => q.card.effects.some((e) => e.kind === 'winOnEmptyDraw')) ? 'draw' : null;
  return sc.kind;
}

// ---------------------------------------------------------------------------
// Each deck's plan: the combos its own list can put together
// ---------------------------------------------------------------------------

export interface ComboPlan {
  combos: Combo[];
  /** Every card that is a piece of one of those combos. */
  pieces: Set<string>;
  /** Cards in the deck that turn unlimited mana into a win (a mill or drain ability, an X draw spell, an empty-library win). */
  finishers: string[];
}

/** Does `c` spend unlimited mana or untaps on a win? */
function isFinisher(c: SimCard): boolean {
  if (X_DRAW_SPELLS.has(c.name)) return true;
  return c.effects.some((e) => e.kind === 'winOnEmptyDraw' || (e.when === 'activated' && !e.activation?.sacrifice && !e.activation?.sacCreature && (e.kind === 'drain' || e.kind === 'damagePlayer' || (e.kind === 'mill' && e.who !== 'you'))));
}

const PLANS = new WeakMap<object, ComboPlan>();

/** The combos `p`'s deck holds every piece of, worked out once per deck. */
export function comboPlan(p: PlayerState): ComboPlan {
  const kept = PLANS.get(p.deck);
  if (kept) return kept;
  const all = [...p.deck.commanders, ...p.deck.cards.map((e) => e.card)];
  const names = new Set(all.map((c) => c.name));
  const finishers = [...new Set(all.filter(isFinisher).map((c) => c.name))];
  const emptyDrawWin = all.some((c) => c.effects.some((e) => e.kind === 'winOnEmptyDraw'));
  // Only what this list can finish: endless mana needs something to spend it on, endless draws an empty-library win.
  const combos = [...COMBOS, ...SPELLBOOK].filter((c) => c.pieces.every((group) => group.some((n) => names.has(n))) && (!c.needsFinisher || finishers.length > 0) && (!c.drawOnly || emptyDrawWin));
  const pieces = new Set([...combos.flatMap((c) => c.pieces.flat().filter((n) => names.has(n))), ...finishers]);
  const plan = { combos, pieces, finishers };
  PLANS.set(p.deck, plan);
  return plan;
}

/** The zones `name` has to be in for the combos of `p`'s plan it belongs to ('B' battlefield, 'H' hand, ...). */
export function pieceZones(p: PlayerState, name: string): string {
  let z = '';
  for (const c of comboPlan(p).combos) {
    const i = c.pieces.findIndex((group) => group.includes(name));
    if (i === -1) continue;
    z += c.zones?.[i] ?? (c.inHand?.includes(i) ? 'BH' : 'B');
  }
  return z;
}

/** Mana from nonland permanents that untap with Dramatic Reversal. */
function rockMana(p: PlayerState): number {
  let n = 0;
  for (const q of p.battlefield) {
    if (q.landInfo || (q.card.isCreature && q.sick)) continue;
    for (const e of q.card.effects) if (e.kind === 'mana') n += e.amount;
  }
  return n;
}

/** What unlimited mana and untaps of nonland permanents would let `p` win with, if anything. */
export function infiniteManaFinisher(p: PlayerState): ComboKind | null {
  let draws = false;
  for (const q of p.battlefield) {
    if (q.landInfo) continue;
    for (const e of q.card.effects) {
      if (e.when !== 'activated' || e.activation?.sacrifice || e.activation?.sacCreature) continue;
      if (e.kind === 'drain' || e.kind === 'damagePlayer') return 'drain';
      if (e.kind === 'mill' && e.who !== 'you') return 'mill';
      if (e.kind === 'draw') draws = true;
    }
  }
  if (draws && p.battlefield.some((q) => q.card.effects.some((e) => e.kind === 'winOnEmptyDraw'))) return 'draw';
  // "Target player draws X cards": aimed at an opponent, it empties their library.
  if (p.hand.some((c) => X_DRAW_SPELLS.has(c.name))) return 'mill';
  return null;
}

const X_DRAW_SPELLS = new Set(["Blue Sun's Zenith", 'Stroke of Genius', 'Braingeyser', 'Prosperity']);

/** Names of every card that is part of a hand-written combo or an alternative win. */
export const WINCON_NAMES = new Set<string>([...COMBOS.flatMap((c) => c.pieces.flat()), ...Object.keys(UPKEEP_WINS)]);

/** A combo `p` has assembled and can finish now, with how it kills. */
export function assembledCombo(g: Game, p: PlayerState): { combo: Combo; kind: ComboKind } | null {
  for (const combo of comboPlan(p).combos) {
    if (combo.zones) {
      const kind = combo.ready!(g, p);
      if (kind) return { combo, kind };
      continue;
    }
    const ok = combo.pieces.every((group, i) => {
      const onField = p.battlefield.some((q) => group.includes(q.card.name));
      if (onField) return true;
      return !!combo.inHand?.includes(i) && (p.hand.some((c) => group.includes(c.name)) || [...g.imprinted.values()].some((c) => group.includes(c.name)));
    });
    if (!ok) continue;
    const kind = combo.ready ? combo.ready(g, p) : combo.kind;
    if (kind) return { combo, kind };
  }
  return null;
}

/**
 * For the bot: the combo pieces `p` still needs, for each combo where it
 * already has at least one piece in hand or on the battlefield.
 */
export function missingComboPieces(p: PlayerState): Set<string> {
  const have = heldNames(p);
  const out = new Set<string>();
  for (const combo of comboPlan(p).combos) {
    const held = combo.pieces.filter((group) => group.some((n) => have.has(n)));
    if (!held.length || held.length === combo.pieces.length) continue;
    for (const group of combo.pieces) if (!group.some((n) => have.has(n))) group.forEach((n) => out.add(n));
  }
  return out;
}

/** Cards `p` holds towards a combo: in hand, on the battlefield, in the command zone, or imprinted and in exile. */
export function heldNames(p: PlayerState): Set<string> {
  return new Set<string>([...p.hand.map((c) => c.name), ...p.battlefield.map((q) => q.card.name), ...p.commandZone.map((c) => c.name), ...p.exile.map((c) => c.name)]);
}

/**
 * What `p` most wants to draw next, best first: the missing pieces of the combo it is closest
 * to (fewest pieces missing, then the most held). Empty when the deck has no combo.
 */
export function wantedPieces(p: PlayerState): string[] {
  const have = heldNames(p);
  const plan = comboPlan(p);
  const finisherHeld = plan.finishers.some((n) => have.has(n));
  const ranked: { missing: string[]; short: number; held: number }[] = [];
  for (const combo of plan.combos) {
    const missing: string[] = [];
    let held = 0;
    let short = 0;
    for (const group of combo.pieces) {
      if (group.some((n) => have.has(n))) held++;
      else {
        missing.push(...group);
        short++;
      }
    }
    // Unlimited mana with nothing to spend it on: the finisher is one more piece.
    if (combo.needsFinisher && plan.finishers.length) {
      if (finisherHeld) held++;
      else {
        missing.push(...plan.finishers);
        short++;
      }
    }
    if (missing.length) ranked.push({ missing, short, held });
  }
  ranked.sort((a, b) => a.short - b.short || b.held - a.held);
  const out: string[] = [];
  for (const r of ranked) for (const n of r.missing) if (!out.includes(n)) out.push(n);
  return out;
}

/** True if `card` completes, or is half of, a combo whose other half `p` already holds. */
export function completesCombo(p: PlayerState, card: SimCard): boolean {
  return missingComboPieces(p).has(card.name);
}
