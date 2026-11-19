// Card-specific rules: cards that get their own reading instead of (or on top of) what the
// general reader makes of their text.
//
// The reader in classify.ts matches card text against general wordings, which covers most
// cards. What is left is a long tail of one-off cards: text no general pattern fits, a short
// name the reader doesn't recognise ("When Loran enters"), or a pattern that fits but misses
// the point (Breach the Multiverse read as just "each player mills ten"). Each entry here
// fixes one card, keyed by its exact English name (the front face for double-faced cards).
//
// An entry can:
// - `text`: give the card's rules in wordings the reader already knows. The card is read
//   from this text instead of its oracle text. Write "~" for the card's own name. This is the
//   preferred form: it stays readable and the reader writes the notes shown on the deck page.
// - `effects`: say exactly what the card does, replacing whatever the reader found.
// - `add`: add effects to what the reader found.
// - `notes`: deck-page notes for the effects given by `effects` or `add`.
// - `keywords`: the card's keywords, replacing the card data's list (which can name abilities
//   it only sometimes has, like Celebr-8000's dice results).
// - `why`: always. What the rule does differently from the oracle text and why, citing the
//   Comprehensive Rules or Scryfall rulings where they decide it. Shown on the deck page.
//
// A card with an entry counts as fully read: the entry is the statement of how this engine
// plays it, approximations included (said in `why`).

import { CARD_RULES_A_TO_F } from './cardRulesAtoF';
import type { Effect, SimCard } from './types';

export interface CardRule {
  text?: string;
  effects?: Effect[];
  add?: Effect[];
  notes?: string[];
  keywords?: string[];
  why: string;
}

export const CARD_RULES: Record<string, CardRule> = {
  // --- Playing cards from exile and the top of the library (classifyExile.ts) -------------
  'Chaos Channeler': {
    text: 'Whenever ~ attacks, exile the top card of your library. You may play that card this turn.',
    why: 'Wild Magic Surge rolls a d20 for one, two or three cards (1–9, 10–19, 20); read as one card, the usual result, played this turn (rule 611.2).',
  },
  'Zur the Enchanter': {
    text: 'Flying\nWhenever ~ attacks, you may search your library for an enchantment card with mana value 3 or less, put it onto the battlefield, then shuffle.',
    why: 'The card calls itself just "Zur", which the reader does not take for its own name.',
  },
  'Hedron Detonator': {
    text: 'Whenever an artifact you control enters, ~ deals 1 damage to target opponent.\n{2}, {T}: Exile the top card of your library. You may play that card this turn.',
    why: 'Sacrificing two artifacts is read as paying {2}: in an artifact deck they are mostly Treasures and Clues. The exiled card is playable this turn (rule 611.2).',
  },
  // --- Misread: the reader found something, but not what the card is about ---------------
  'Breach the Multiverse': {
    effects: [
      { kind: 'mill', n: 10, who: 'all', when: 'resolve' },
      { kind: 'recursion', n: 4, toBattlefield: true, from: 'any', what: 'creatureOrPlaneswalker', when: 'resolve' },
    ],
    notes: ['Mill 10 (everyone)', 'Then take up to four creature or planeswalker cards from graveyards onto the battlefield'],
    why: 'The reader saw only the mill. One card is taken from each player\'s graveyard; here it is up to four from any graveyards.',
  },
  'Mana Drain': {
    effects: [{ kind: 'counter', target: 'any', refund: true, when: 'resolve' }],
    notes: ['Counterspell (any), then mana equal to the countered spell\'s mana value'],
    why: 'The {C} comes at your next main phase; here it is kept as one-shot mana right away.',
  },
  'Mental Misstep': {
    effects: [{ kind: 'counter', target: 'any', cmc: 1, when: 'resolve' }],
    notes: ['Counterspell (only spells with mana value 1)'],
    why: 'The reader let it counter any spell.',
  },
  'Sign in Blood': {
    text: 'Draw two cards.\nYou lose 2 life.',
    why: 'The reader missed the life loss. Aimed at yourself, as it nearly always is.',
  },
  Bedevil: {
    effects: [{ kind: 'removal', target: 'permanent', mode: 'destroy', amount: 0, when: 'resolve' }],
    notes: ['Removal: destroy artifact, creature or planeswalker'],
    why: 'The reader read it as artifact-or-enchantment removal, so it could never hit a creature.',
  },
  'Black Market Connections': {
    text: 'At the beginning of your upkeep, create a Treasure token.\nAt the beginning of your upkeep, draw a card.\nAt the beginning of your upkeep, you lose 3 life.',
    why: '"Choose one or more": bots take the Treasure and the card each turn (3 life). The reader kept only the card. The 3/2 token mode is left out.',
  },
  'Massacre Wurm': {
    text: 'When ~ enters, creatures your opponents control get -2/-2 until end of turn.\nWhenever a creature an opponent controls dies, ~ deals 2 damage to target opponent.',
    why: 'The 2 life loss on each opponent\'s creature dying was unread. It goes to the opponent the bot picks rather than that creature\'s controller.',
  },

  // --- Short names and wordings the reader can't match ----------------------------------
  'Loran of the Third Path': {
    text: 'Vigilance\nWhen ~ enters, destroy up to one target artifact or enchantment.\n{T}: You and target opponent each draw a card.',
    why: 'Its text says "When Loran enters", a short name the reader didn\'t recognise.',
  },
  'Power Conduit': {
    text: '{T}: Put a charge counter on target artifact you control.',
    why: 'The deck data has no rules text for this card. Its real text: "{T}, Remove a counter from a permanent you control: Choose one — put a charge counter on target artifact; or put a +1/+1 counter on target creature."',
  },
  'Changeling Outcast': {
    text: "~ can't be blocked.\n~ can't block.",
    why: '"Can\'t block and can\'t be blocked" in one sentence; read as the two rules it is.',
  },
  Dispatch: {
    text: 'Metalcraft — If you control three or more artifacts, exile target creature.',
    why: 'Tapping is only worth something with the exile, which needs three artifacts (about half the time in its decks).',
  },
  'Venser, Shaper Savant': {
    text: 'Flash\nWhen ~ enters, return target nonland permanent to its owner\'s hand.',
    why: '"Target spell or permanent": bots use it on permanents; bouncing a spell isn\'t modelled.',
  },

  // --- Lines that are deliberately not played --------------------------------------------
  "Sensei's Divining Top": {
    text: '{1}: Look at the top three cards of your library, then put them back in any order.',
    why: 'Its draw puts the Top back on the library, so it is card selection, not card advantage. Only the look is played: it really puts the top three back in the order the player picks.',
  },
  'Animate Dead': {
    text: 'When ~ enters, put target creature card from a graveyard onto the battlefield under your control.',
    why: 'The returned creature\'s -1/-0 is left out.',
  },
  "Dawn's Truce": {
    text: 'You and permanents you control gain hexproof until end of turn.\nPermanents you control gain indestructible until end of turn.',
    why: 'The gift is always promised (an opponent draws a card) so your permanents also get indestructible; the opponent\'s card is not given.',
  },
  'Gitaxian Probe': {
    text: 'Draw a card.',
    why: 'Bots already see every hand, so looking at one adds nothing.',
  },

  // --- Approximations of effects the engine has no exact form for --------------------------
  'Narset, Parter of Veils': {
    text: "Each opponent can't draw more than one card each turn.\n−2: Draw a card.",
    why: '-2 finds a noncreature, nonland card in the top four most of the time in the decks it is in; played as drawing one.',
  },
  'Jace, the Mind Sculptor': {
    text: '+2: Scry 1.\n0: Draw three cards, then put two cards from your hand on top of your library in any order.\n−1: Return target creature to its owner\'s hand.',
    why: 'The +2 (fateseal) is played as scry 1, mainly to build loyalty. The -12 is left out: a bot almost never gets there.',
  },
  'Fallen Shinobi': {
    text: 'Ninjutsu {2}{U}{B}\nWhenever ~ deals combat damage to a player, draw two cards.',
    why: 'Playing the top two cards of their library for free is played as drawing two.',
  },
  'Thief of Sanity': {
    text: 'Flying\nWhenever ~ deals combat damage to a player, draw a card.',
    why: 'Taking one of their top three cards to cast is played as drawing one.',
  },
  'Silent Hallcreeper': {
    text: "~ can't be blocked.\nWhenever ~ deals combat damage to a player, draw a card.",
    why: 'Each mode can be chosen once; the card draw is the one bots use most. The counters and copy modes are left out.',
  },
  Ephemerate: {
    effects: [
      { kind: 'blink', n: 1, what: 'creature', when: 'resolve' },
      { kind: 'blink', n: 1, what: 'creature', when: 'resolve' },
    ],
    notes: ['Blink a creature you control, twice (rebound)'],
    why: 'Rebound (rule 702.88) casts it again at your next upkeep; both blinks happen at once here.',
  },
  'Ominous Seas': {
    effects: [{ kind: 'tokens', n: 1, power: 8, toughness: 8, keywords: [], when: 'draw', chance: 0.125 }],
    notes: ['An 8/8 Kraken for every eight cards you draw', 'Cycling {2}: discard to draw a card'],
    why: 'Foreshadow counters are not tracked: each draw has a one-in-eight chance to make the Kraken, which comes to the same rate.',
  },
  Mirrormade: {
    effects: [{ kind: 'copyPermanent', when: 'resolve' }],
    notes: ['Enters as a copy of an artifact or enchantment (played as a token copy of the best one on the battlefield)'],
    why: 'The engine copies permanents as tokens, so this makes a token copy of the best nonlegendary artifact or enchantment on the battlefield and stays on the battlefield itself.',
  },
  'Cursed Mirror': {
    text: '{T}: Add {R}.',
    why: 'Copying a creature for one turn is left out; it plays as a mana rock.',
  },
  Shadowspear: {
    text: 'Equipped creature gets +1/+1 and has trample and lifelink.\nEquip {2}',
    why: 'Turning off opponents\' hexproof and indestructible for {1} is left out.',
  },
  Aetherize: {
    effects: [{ kind: 'fog', who: 'you', bounce: true, when: 'resolve' }],
    notes: ['Return all creatures attacking you to their owners\' hands'],
    why: 'Only creatures attacking you: in multiplayer the bot casts it when it is attacked.',
  },

  ...CARD_RULES_A_TO_F,
};

/** Apply a card's own rule to what the reader made of it. The caller re-derives `modeled` and `value`. */
export function applyCardRule(card: SimCard, rule: CardRule): void {
  if (rule.effects) {
    card.effects = rule.effects.map((e) => ({ ...e }));
    // Notes the reader wrote about its effects no longer apply; keep the body line and the others.
    card.notes = card.notes.filter((n) => /^(Creature|Vehicle|Planeswalker|Flash|Can't be countered|Back face|Transforms)/.test(n));
  }
  if (rule.add) card.effects.push(...rule.add.map((e) => ({ ...e })));
  if (rule.notes) card.notes.push(...rule.notes);
  card.unread = undefined;
  card.ruled = rule.why;
  card.notes.push(`Own rule: ${rule.why}`);
}
