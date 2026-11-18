// Ways to win that don't go through combat: alternative win conditions printed
// on cards, and well-known two-card combos that win on the spot.
//
// These are looked up by card name, so they work for decks that were imported
// before this file existed (decks are stored already classified, without their
// rules text). The engine (game.ts) checks them; the bot (bot.ts) uses the same
// tables to recognise what it is building towards and what to stop.

import type { SimCard } from '../engine/types';
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

/** Revel in Riches: a Treasure whenever a creature an opponent controls dies. */
export const TREASURE_ON_OPPONENT_DEATH = new Set(['Revel in Riches']);

// ---------------------------------------------------------------------------
// Combos
// ---------------------------------------------------------------------------

export type ComboKind = 'drain' | 'mill' | 'draw';

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
    ready: (_g, p) => (p.battlefield.some((q) => q.card.name === 'Bloodchief Ascension' && q.counters >= 3) ? 'drain' : null),
  },
  // Dramatic Reversal on Isochron Scepter with three mana of rocks: infinite mana and untaps, which needs something to spend them on.
  {
    name: 'Isochron Scepter + Dramatic Reversal',
    pieces: [['Isochron Scepter'], ['Dramatic Reversal']],
    inHand: [1],
    kind: 'mill',
    ready: (g, p) => {
      const scepter = p.battlefield.find((q) => q.card.name === 'Isochron Scepter' && g.imprinted.get(q.id)?.name === 'Dramatic Reversal');
      if (!scepter || scepter.tapped || g.availableMana(p) < 2) return null;
      return infiniteManaFinisher(p) && rockMana(p) >= 3 ? infiniteManaFinisher(p) : null;
    },
  },
];

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

/** Names of every card that is part of a combo or an alternative win. */
export const WINCON_NAMES = new Set<string>([...COMBOS.flatMap((c) => c.pieces.flat()), ...Object.keys(UPKEEP_WINS)]);

/** A combo `p` has assembled and can finish now, with how it kills. */
export function assembledCombo(g: Game, p: PlayerState): { combo: Combo; kind: ComboKind } | null {
  for (const combo of COMBOS) {
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
  const have = new Set<string>([...p.hand.map((c) => c.name), ...p.battlefield.map((q) => q.card.name)]);
  const out = new Set<string>();
  for (const combo of COMBOS) {
    const held = combo.pieces.filter((group) => group.some((n) => have.has(n)));
    if (!held.length || held.length === combo.pieces.length) continue;
    for (const group of combo.pieces) if (!group.some((n) => have.has(n))) group.forEach((n) => out.add(n));
  }
  return out;
}

/** True if `card` completes, or is half of, a combo whose other half `p` already holds. */
export function completesCombo(p: PlayerState, card: SimCard): boolean {
  return missingComboPieces(p).has(card.name);
}
