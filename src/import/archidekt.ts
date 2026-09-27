// Import a deck from Archidekt's public API (through our /api/archidekt proxy).

import { classifyCard, type RawCard } from '../engine/classify';
import type { Color, Mana, SimDeck } from '../engine/types';
import { buildDeck, type ImportedCard } from './deck';

const COLOR_NAMES: Record<string, Color> = { White: 'W', Blue: 'U', Black: 'B', Red: 'R', Green: 'G' };

/** Accepts a full Archidekt URL or a bare deck id. */
export function parseArchidektId(input: string): string | null {
  const trimmed = input.trim();
  if (/^\d+$/.test(trimmed)) return trimmed;
  const m = trimmed.match(/archidekt\.com\/(?:api\/)?decks\/(\d+)/i);
  return m ? m[1] : null;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export function archidektToRaw(oc: any, uid?: string): RawCard {
  const faces: any[] = oc.faces?.length ? oc.faces : [];
  const front = faces[0] ?? oc;
  const produced: Mana[] = [];
  for (const [k, v] of Object.entries(oc.manaProduction ?? {})) if (v) produced.push(k as Mana);
  const back = faces[1];
  return {
    name: oc.name,
    manaCost: front.manaCost ?? oc.manaCost ?? '',
    cmc: oc.cmc ?? 0,
    types: front.types ?? oc.types ?? [],
    superTypes: front.superTypes ?? oc.superTypes ?? [],
    subTypes: front.subTypes ?? oc.subTypes ?? [],
    text: front.text ?? oc.text ?? '',
    power: front.power ?? oc.power,
    toughness: front.toughness ?? oc.toughness,
    keywords: oc.keywords ?? [],
    colorIdentity: (oc.colorIdentity ?? []).map((c: string) => COLOR_NAMES[c]).filter(Boolean),
    producedMana: produced.length ? produced : undefined,
    layout: oc.layout,
    back: back ? { name: back.name, types: back.types ?? [], subTypes: back.subTypes ?? [], text: back.text ?? '' } : null,
    imageUrl: uid ? `https://cards.scryfall.io/normal/front/${uid[0]}/${uid[1]}/${uid}.jpg` : undefined,
  };
}

export async function importArchidekt(input: string): Promise<SimDeck> {
  const id = parseArchidektId(input);
  if (!id) throw new Error('That doesn\'t look like an Archidekt deck URL or id.');
  const res = await fetch(`/api/archidekt?id=${id}`);
  if (res.status === 404) throw new Error('Archidekt says that deck doesn\'t exist (or it is private).');
  if (!res.ok) throw new Error(`Archidekt request failed (${res.status}).`);
  const data: any = await res.json();

  // Categories flagged "not included in deck" (Maybeboard, Sideboard...) are skipped.
  const excluded = new Set<string>(
    (data.categories ?? []).filter((c: any) => c.includedInDeck === false).map((c: any) => c.name),
  );
  const premier = new Set<string>(
    (data.categories ?? []).filter((c: any) => c.isPremier).map((c: any) => c.name),
  );

  const cards: ImportedCard[] = [];
  for (const entry of data.cards ?? []) {
    const cats: string[] = entry.categories ?? [];
    if (cats.length && cats.every((c) => excluded.has(c))) continue;
    const raw = archidektToRaw(entry.card.oracleCard, entry.card.uid);
    cards.push({
      card: classifyCard(raw),
      count: entry.quantity ?? 1,
      isCommander: cats.some((c) => premier.has(c) || c.toLowerCase() === 'commander'),
      colorIdentity: raw.colorIdentity,
    });
  }
  const deck = buildDeck({
    id: `archidekt-${id}`,
    name: data.name ?? `Archidekt ${id}`,
    source: 'archidekt',
    url: `https://archidekt.com/decks/${id}`,
    cards,
  });
  deck.archidektBracket = typeof data.edhBracket === 'number' ? data.edhBracket : null;
  deck.archidektUpdatedAt = data.updatedAt ? Date.parse(data.updatedAt) : undefined;
  return deck;
}

/** One deck in an Archidekt user's deck list. */
export interface ArchidektDeckSummary {
  id: string;
  name: string;
  size: number;
  updatedAt: number;
  /** Archidekt format id; 3 is Commander / EDH. */
  format: number;
  bracket: number | null;
  image: string | null;
}

export const ARCHIDEKT_COMMANDER_FORMAT = 3;

/** A user's public decks (private and unlisted decks aren't visible without logging in). */
export async function listArchidektDecks(username: string): Promise<ArchidektDeckSummary[]> {
  const name = username.trim().replace(/^.*archidekt\.com\/u(?:ser)?\//i, '').replace(/\/.*$/, '');
  if (!name) throw new Error('Enter your Archidekt username.');
  const res = await fetch(`/api/archidekt?user=${encodeURIComponent(name)}`);
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `Archidekt request failed (${res.status}).`);
  if (!data.results?.length) throw new Error(`No public decks found for "${name}". Check the spelling, and note that private and unlisted decks can't be listed.`);
  return data.results
    .map((d: any) => ({
      id: String(d.id),
      name: d.name,
      size: d.size ?? 0,
      updatedAt: Date.parse(d.updatedAt ?? '') || 0,
      format: d.deckFormat,
      bracket: typeof d.edhBracket === 'number' ? d.edhBracket : null,
      image: d.featured || null,
    }))
    .sort((a: ArchidektDeckSummary, b: ArchidektDeckSummary) => b.updatedAt - a.updatedAt);
}
