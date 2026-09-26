// Import a plain-text decklist (Archidekt/Moxfield/MTGO export) using
// Scryfall for card data. Scryfall allows browser requests, so no proxy.

import { classifyCard, type RawCard } from '../engine/classify';
import type { Color, Mana } from '../engine/types';
import type { SimDeck } from '../engine/types';
import { buildDeck, type ImportedCard } from './deck';

export interface ParsedLine {
  name: string;
  count: number;
  isCommander: boolean;
}

const SKIP_SECTIONS = /^(sideboard|maybeboard|considering|tokens?)\b/i;

/**
 * Understands lines like:
 *   1 Sol Ring
 *   1x Xyris, the Writhing Storm (c21) 1 [Commander{top}]
 *   1 Atraxa, Praetors' Voice *CMDR*
 * and section headers like "Commander", "// Commander", "Sideboard:".
 */
export function parseDecklist(text: string): ParsedLine[] {
  const out: ParsedLine[] = [];
  let section = '';
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const header = line.replace(/^\/\/\s*|^#+\s*|:$/g, '').trim();
    const m = line.match(/^(\d+)\s*x?\s+(.+)$/i);
    if (!m) {
      section = header.toLowerCase();
      continue;
    }
    if (SKIP_SECTIONS.test(section)) continue;
    let name = m[2];
    const tags = (name.match(/\[([^\]]*)\]/)?.[1] ?? '').toLowerCase();
    const cmdrTag = /\*cmdr\*/i.test(name) || /\bcommander\b/.test(tags);
    if (/maybeboard|sideboard|considering/.test(tags)) continue;
    name = name
      .replace(/\[[^\]]*\]/g, '')
      .replace(/\*[^*]*\*/g, '')
      .replace(/\^[^^]*\^/g, '')
      .replace(/\s\([a-z0-9]{2,6}\)\s*[\w-★]*\s*$/i, '')
      .replace(/\s+/g, ' ')
      .trim();
    out.push({ name, count: parseInt(m[1], 10), isCommander: cmdrTag || /^commanders?$/.test(section) });
  }
  return out;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function parseTypeLine(typeLine: string) {
  const [left, right = ''] = typeLine.split(' — ');
  const words = left.split(' ');
  const SUPER = ['Legendary', 'Basic', 'Snow', 'World', 'Ongoing'];
  return {
    superTypes: words.filter((w) => SUPER.includes(w)),
    types: words.filter((w) => !SUPER.includes(w)),
    subTypes: right.split(' ').filter(Boolean),
  };
}

export function scryfallToRaw(card: any): RawCard {
  const faces: any[] = card.card_faces ?? [];
  const front = faces[0] ?? card;
  const t = parseTypeLine(front.type_line ?? card.type_line ?? '');
  const back = faces[1];
  const bt = back ? parseTypeLine(back.type_line ?? '') : null;
  return {
    name: card.name,
    manaCost: front.mana_cost ?? card.mana_cost ?? '',
    cmc: card.cmc ?? 0,
    ...t,
    text: front.oracle_text ?? card.oracle_text ?? '',
    power: front.power ?? card.power,
    toughness: front.toughness ?? card.toughness,
    keywords: card.keywords ?? [],
    colorIdentity: (card.color_identity ?? []) as Color[],
    producedMana: card.type_line?.includes('Land') ? ((card.produced_mana ?? []) as Mana[]) : undefined,
    layout: card.layout,
    back: back && bt ? { name: back.name, types: bt.types, subTypes: bt.subTypes, text: back.oracle_text ?? '' } : null,
    imageUrl: card.image_uris?.normal ?? front.image_uris?.normal,
  };
}

async function fetchScryfall(names: string[]): Promise<Map<string, any>> {
  const found = new Map<string, any>();
  for (let i = 0; i < names.length; i += 75) {
    const chunk = names.slice(i, i + 75);
    const res = await fetch('https://api.scryfall.com/cards/collection', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ identifiers: chunk.map((name) => ({ name: name.split(' // ')[0] })) }),
    });
    if (!res.ok) throw new Error(`Scryfall request failed (${res.status}).`);
    const data = await res.json();
    for (const card of data.data ?? []) {
      found.set(card.name.toLowerCase(), card);
      for (const face of card.card_faces ?? []) found.set(face.name.toLowerCase(), card);
    }
    if (i + 75 < names.length) await new Promise((r) => setTimeout(r, 120)); // be polite
  }
  return found;
}

export async function importText(name: string, text: string): Promise<SimDeck> {
  const lines = parseDecklist(text);
  if (!lines.length) throw new Error('No cards found. Lines should look like "1 Sol Ring".');
  const unique = [...new Set(lines.map((l) => l.name))];
  const data = await fetchScryfall(unique);
  const missing: string[] = [];
  const cards: ImportedCard[] = [];
  for (const line of lines) {
    const sc = data.get(line.name.toLowerCase()) ?? data.get(line.name.split(' // ')[0].toLowerCase());
    if (!sc) {
      missing.push(line.name);
      continue;
    }
    const raw = scryfallToRaw(sc);
    cards.push({ card: classifyCard(raw), count: line.count, isCommander: line.isCommander, colorIdentity: raw.colorIdentity });
  }
  if (missing.length > 5) throw new Error(`Scryfall didn't recognise ${missing.length} cards, e.g. ${missing.slice(0, 5).join(', ')}.`);
  const id = `text-${hash(name + text)}`;
  return buildDeck({ id, name: name || 'Untitled deck', source: 'text', cards });
}

function hash(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}
