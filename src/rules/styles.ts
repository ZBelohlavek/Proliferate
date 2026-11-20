// How each deck is meant to win, read from its own list: Voltron, go-wide tokens,
// aristocrats, spellslinger, control, reanimator, +1/+1 counters, ramp, blink,
// mill, drain, land hate, combo. The bot (bot.ts) steers its plays by these.
//
// Worked out once per deck from the classified cards (no oracle text needed), so
// it works for decks imported before this file existed.

import type { SimCard, SimDeck } from '../engine/types';

export type Style =
  | 'voltron' | 'tokens' | 'aristocrats' | 'spells' | 'control' | 'reanimator'
  | 'counters' | 'ramp' | 'blink' | 'mill' | 'drain' | 'landHate' | 'beatdown';

export interface DeckStyle {
  /** Every style the list leans on, strongest first. */
  styles: Style[];
  /** Card counts behind the reading (nonland cards, by copies). */
  counts: Record<string, number>;
}

/** What each style means for how the deck wins, for the deck report. */
export const STYLE_PLANS: Record<Style, string> = {
  voltron: 'Suits up one creature (usually the commander) with Equipment and Auras and wins by commander damage',
  tokens: 'Goes wide with tokens, pumps them with anthems and swings with everything',
  aristocrats: 'Sacrifices its own creatures for value and drains the table each time one dies',
  spells: 'Chains instants and sorceries off permanents that trigger on every spell cast',
  control: 'Holds up counterspells and removal, answers threats and wins late',
  reanimator: 'Puts big creatures into the graveyard and brings them back cheaply',
  counters: 'Grows its creatures with +1/+1 counters',
  ramp: 'Ramps hard into expensive threats',
  blink: 'Flickers its creatures to reuse what they do when they enter',
  mill: 'Mills opponents out',
  drain: 'Drains and burns players directly',
  landHate: 'Destroys or punishes lands to lock the table out',
  beatdown: 'Develops creatures and wins in combat',
};

const STYLES = new WeakMap<SimDeck, DeckStyle>();

const LAND_HATE = new Set(['landRule', 'tapPunish', 'landWipe', 'landSac', 'nonbasicBurn', 'landDiesPunish']);

/** What one card counts towards. */
function tags(c: SimCard): Set<string> {
  const t = new Set<string>();
  if (c.isCreature) t.add('creature');
  if (c.isInstant || c.isSorcery) t.add('spell');
  for (const e of c.effects) {
    if (e.kind === 'equip' && !e.steal && !e.lock) t.add('gear');
    if (e.kind === 'tokens' || e.kind === 'tokenCopy') t.add('tokens');
    if (e.kind === 'anthem' || e.kind === 'overrun') t.add('anthem');
    if (e.activation?.sacCreature || e.kind === 'sacrificeOther') t.add('sacOutlet');
    if ((e.kind === 'drain' || e.kind === 'damagePlayer' || e.kind === 'draw') && e.when === 'creatureDies' && e.scope !== 'self') t.add('deathPayoff');
    if (e.when === 'cast' && !c.isInstant && !c.isSorcery) t.add('castTrigger');
    if (e.kind === 'counter' && e.when === 'resolve') t.add('counterspell');
    if ((e.kind === 'removal' || e.kind === 'wipe') && e.when === 'resolve') t.add('removal');
    if (e.kind === 'recursion' && e.toBattlefield) t.add('reanimate');
    if (e.kind === 'entomb' || (e.kind === 'mill' && e.who === 'you')) t.add('selfMill');
    if (e.kind === 'counters') t.add('counters');
    if (e.kind === 'mana' || e.kind === 'ramp' || e.kind === 'treasure' || e.kind === 'extraLand') t.add('ramp');
    if (e.kind === 'blink') t.add('blink');
    if (e.kind === 'mill' && e.who !== 'you' && e.who !== 'all') t.add('mill');
    if (e.kind === 'drain' || e.kind === 'damagePlayer') t.add('drain');
    if (LAND_HATE.has(e.kind) || (e.kind === 'removal' && (e.target === 'land' || e.target === 'nonbasicLand'))) t.add('landHate');
  }
  return t;
}

/** The styles `deck` is built around, worked out once per deck. */
export function deckStyle(deck: SimDeck): DeckStyle {
  const kept = STYLES.get(deck);
  if (kept) return kept;
  const counts: Record<string, number> = {};
  const all = [...deck.commanders.map((card) => ({ card, count: 1 })), ...deck.cards];
  for (const { card, count } of all) {
    if (card.isLand) continue;
    for (const t of tags(card)) counts[t] = (counts[t] ?? 0) + count;
  }
  const n = (k: string) => counts[k] ?? 0;
  const commander = deck.commanders[0];
  const scored: [Style, number][] = [
    // Strength of each reading, relative to where it starts to count.
    ['voltron', n('gear') / 7],
    // Go wide: lots of tokens, or tokens with anthems, or a creature deck full of anthems.
    ['tokens', Math.max(n('tokens') / 14, Math.min(n('tokens') / 9, (n('anthem') + 1) / 5), n('creature') >= 20 ? n('anthem') / 8 : 0)],
    ['aristocrats', Math.min(n('sacOutlet') / 3, n('deathPayoff') / 3)],
    ['spells', Math.max(n('spell') / 32, Math.min(n('spell') / 20, n('castTrigger') / 7))],
    ['control', Math.max(n('counterspell') / 10, Math.min(n('counterspell') / 6, (n('counterspell') + n('removal')) / 22) * (n('creature') <= 18 ? 1 : 0.8))],
    ['reanimator', Math.min(n('reanimate') / 6, (n('selfMill') + 3) / 5)],
    ['counters', n('counters') / 9],
    ['ramp', n('ramp') / 18],
    ['blink', n('blink') / 5],
    ['mill', n('mill') / 6],
    ['drain', n('drain') / 10],
    ['landHate', n('landHate') / 8],
  ];
  // A commander that equips, makes tokens or rewards spells points the deck at that style.
  if (commander) {
    const ct = tags(commander);
    for (const s of scored) {
      if ((s[0] === 'tokens' && ct.has('tokens')) || (s[0] === 'spells' && ct.has('castTrigger')) || (s[0] === 'aristocrats' && (ct.has('sacOutlet') || ct.has('deathPayoff')))) s[1] *= 1.25;
    }
  }
  const styles: Style[] = scored.filter(([, v]) => v >= 1).sort((a, b) => b[1] - a[1]).map(([s]) => s);
  // Nothing else stands out: a creature deck that wins in combat.
  if (!styles.length && n('creature') >= 18) styles.push('beatdown');
  const out = { styles, counts };
  STYLES.set(deck, out);
  return out;
}

export function hasStyle(deck: SimDeck, s: Style): boolean {
  return deckStyle(deck).styles.includes(s);
}
