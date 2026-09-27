// Counts what a deck is made of (ramp, draw, removal, curve...) from the
// effects the classifier recognised. Approximate, like the classifier itself.

import type { EffectKind, SimDeck } from '../engine/types';

export interface Composition {
  lands: number;
  creatures: number;
  avgManaValue: number;
  ramp: number;
  draw: number;
  removal: number;
  wipes: number;
  counters: number;
  tutors: number;
  protection: number;
  /** Non-land cards by mana value: index 0..6, index 7 = 7+. */
  curve: number[];
}

const has = (kinds: Set<EffectKind>, ...wanted: EffectKind[]) => wanted.some((k) => kinds.has(k));

export function composition(deck: SimDeck): Composition {
  const c: Composition = { lands: 0, creatures: 0, avgManaValue: 0, ramp: 0, draw: 0, removal: 0, wipes: 0, counters: 0, tutors: 0, protection: 0, curve: new Array(8).fill(0) };
  let mvSum = 0;
  let nonland = 0;
  for (const { card, count } of [...deck.cards, ...deck.commanders.map((card) => ({ card, count: 1 }))]) {
    if (card.isLand) {
      c.lands += count;
      continue;
    }
    nonland += count;
    mvSum += card.cmc * count;
    c.curve[Math.min(7, Math.round(card.cmc))] += count;
    if (card.isCreature) c.creatures += count;
    const kinds = new Set(card.effects.map((e) => e.kind));
    if (has(kinds, 'mana', 'ramp', 'treasure', 'costReduction', 'extraLand')) c.ramp += count;
    if (has(kinds, 'draw')) c.draw += count;
    if (has(kinds, 'removal')) c.removal += count;
    if (has(kinds, 'wipe')) c.wipes += count;
    if (has(kinds, 'counter')) c.counters += count;
    if (has(kinds, 'tutor')) c.tutors += count;
    if (has(kinds, 'protect') || card.effects.some((e) => e.kind === 'pump' && e.protect)) c.protection += count;
  }
  c.avgManaValue = nonland ? mvSum / nonland : 0;
  return c;
}
