// The predefined artifact tokens (rule 111.10): Food, Blood and Incubator tokens
// are real permanents with their own abilities, read by the card reader from
// their reminder text so the engine and the bots use them like any artifact.

import { classifyCard, type RawCard } from './classify';
import type { SimCard } from './types';

const raw = (name: string, subType: string, text: string, back?: RawCard['back']): RawCard => ({
  name, manaCost: '', cmc: 0, types: ['Artifact'], superTypes: [], subTypes: [subType], text,
  power: null, toughness: null, keywords: [], colorIdentity: [], layout: back ? 'transform' : 'token', back: back ?? null,
});

const finish = (card: SimCard, typeLine: string): SimCard => {
  card.typeLine = typeLine;
  card.value = 0;
  return card;
};

let food: SimCard | null = null;
let blood: SimCard | null = null;
let incubator: SimCard | null = null;

/** Food: "{2}, {T}, Sacrifice this token: You gain 3 life." (rule 111.10b) */
export function foodCard(): SimCard {
  return (food ??= finish(classifyCard(raw('Food', 'Food', '{2}, {T}, Sacrifice this token: You gain 3 life.')), 'Token Artifact — Food'));
}

/** Blood: "{1}, {T}, Discard a card, Sacrifice this token: Draw a card." (rule 111.10g) */
export function bloodCard(): SimCard {
  return (blood ??= finish(classifyCard(raw('Blood', 'Blood', '{1}, {T}, Discard a card, Sacrifice this token: Draw a card.')), 'Token Artifact — Blood'));
}

/**
 * Incubator (rule 701.53): a colorless artifact with "{2}: Transform this artifact." whose back face is a 0/0
 * Phyrexian artifact creature. It is made with +1/+1 counters, which the Phyrexian keeps.
 */
export function incubatorCard(): SimCard {
  if (incubator) return incubator;
  const card = classifyCard(raw('Incubator', 'Incubator', '{2}: Transform this artifact.', { name: 'Phyrexian Token', types: ['Artifact', 'Creature'], subTypes: ['Phyrexian'], text: '', power: '0', toughness: '0' }));
  card.back!.typeLine = 'Token Artifact Creature — Phyrexian';
  card.back!.value = 0;
  return (incubator = finish(card, 'Token Artifact — Incubator'));
}

export const isFood = (card: SimCard) => /\bFood\b/.test(card.typeLine);
export const isIncubator = (card: SimCard) => card.name === 'Incubator';
