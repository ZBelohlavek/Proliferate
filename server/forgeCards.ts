// Knows which cards Forge has scripts for, and the exact name Forge expects
// for each one in a .dck file.

import { readZip } from './zip.ts';

/**
 * Forge's card file name for a card: the full name (both faces for
 * multi-face cards) lowercased, accents and apostrophes dropped, everything
 * else non-alphanumeric turned into underscores.
 *   "Y'shtola, Night's Blessed"          -> yshtola_nights_blessed
 *   "Khalni Ambush // Khalni Territory"  -> khalni_ambush_khalni_territory
 */
export function forgeSlug(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

export class ForgeCardDb {
  /** slug -> name to write in the deck file */
  private readonly names = new Map<string, string>();

  constructor(cardsZipPath: string) {
    for (const entry of readZip(cardsZipPath)) {
      if (!entry.name.endsWith('.txt')) continue;
      const slug = entry.name.replace(/^.*\//, '').replace(/\.txt$/, '');
      const text = entry.read().toString('utf8');
      const faceNames = [...text.matchAll(/^Name:(.*)$/gm)].map((m) => m[1].trim());
      if (!faceNames.length) continue;
      // Split cards are written with both halves ("Fire // Ice"); every
      // other multi-face card (MDFC, adventure, transform) by its front face.
      const split = /^AlternateMode:Split/m.test(text);
      this.names.set(slug, split ? faceNames.join(' // ') : faceNames[0]);
    }
  }

  get size(): number {
    return this.names.size;
  }

  /** The Forge deck-file name for a card, or null if Forge doesn't know it. */
  lookup(name: string): string | null {
    return this.names.get(forgeSlug(name)) ?? this.names.get(forgeSlug(name.split(' // ')[0])) ?? null;
  }
}
