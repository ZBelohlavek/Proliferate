// The last rules-bending cards in Zach's decks: cards the engine used to play as blank, now with the engine
// pieces they need (see resolveFinal and friends in src/rules/game.ts). Spread into CARD_RULES after every
// other rules file, so these entries win.

import type { CardRule } from './cardRules';
import type { Effect, ManaCost } from './types';

const cost = (generic: number, pips: string[][] = []): ManaCost => ({ generic, pips: pips as ManaCost['pips'], x: 0, life: 0 });
const act = (c: ManaCost, tap: boolean, more: Partial<NonNullable<Effect['activation']>> = {}): NonNullable<Effect['activation']> => ({ cost: c, tap, sacrifice: false, ...more });

export const FINAL_RULES: Record<string, CardRule> = {
  'Cybermen Squadron': {
    effects: [{ kind: 'anthem', p: 0, t: 0, keywords: ['myriad'], only: 'artifact', nonlegendary: true, when: 'static' }],
    notes: ['Nonlegendary artifact creatures you control have myriad'],
    why: 'Myriad granted to your nonlegendary artifact creatures, itself included (rule 702.116).',
  },
  'Alter Reality': {
    effects: [{ kind: 'textChange', until: 'forever', when: 'resolve' }],
    notes: ['Changes a color word in a permanent\'s text for good: an opponent\'s protection from your color, or your own protection to the color your opponents play'],
    why: 'Text changes (rule 612) only matter where the engine reads a color word: protection from a color. Spells on the stack can\'t be targeted here. With Orvar or Vesuvan Duplimancy out, bots cast it on their own best permanent to copy it.',
  },
  'Whim of Volrath': {
    effects: [{ kind: 'textChange', until: 'eot', landTypes: true, when: 'resolve' }],
    notes: ['Changes a color word or basic land type in a permanent\'s text until end of turn: protection from a color, landwalk'],
    why: 'Text changes (rule 612) only matter where the engine reads a color word or land type: protection from a color and landwalk. With Orvar or Vesuvan Duplimancy out, bots cast it (with buyback when they can) on their own best permanent to copy it.',
  },
  'Tel-Jilad Stylus': {
    effects: [{ kind: 'ownPerm', to: 'bottom', when: 'activated', activation: act(cost(0), true) }],
    notes: ['{T}: Put target permanent you own on the bottom of your library'],
    why: 'Bots use it to take back a permanent an opponent stole, or to save one from being exiled or stolen.',
  },
  'Despotic Scepter': {
    effects: [{ kind: 'ownPerm', to: 'destroy', when: 'activated', activation: act(cost(0), true) }],
    notes: ['{T}: Destroy target permanent you own'],
    why: 'Bots use it to deny a permanent an opponent stole, or to put one into the graveyard before it is exiled or stolen. "It can\'t be regenerated" is left out: regeneration only matters against destroy effects the engine already checks.',
  },
  'Claws of Gix': {
    effects: [{ kind: 'gainLife', n: 1, when: 'activated', activation: act(cost(1), false, { sacOther: { what: 'permanent', n: 1 } }) }],
    notes: ['{1}, Sacrifice a permanent: You gain 1 life'],
    why: 'A sacrifice outlet for any permanent: bots use it in answer to a spell that would exile or steal one of theirs.',
  },
  'Desecrated Tomb': {
    effects: [{ kind: 'tokens', n: 1, power: 1, toughness: 1, keywords: ['flying'], subtypes: ['bat'], when: 'leaveGraveyard' }],
    notes: ['Whenever one or more creature cards leave your graveyard: a 1/1 flying Bat'],
    why: 'Checked after each spell or ability: one Bat however many creature cards left your graveyard at once.',
  },
  'Enchanted Evening': {
    effects: [{ kind: 'addTypes', types: ['enchantment'], who: 'all', when: 'static' }],
    notes: ['All permanents are enchantments too'],
    why: 'Every permanent is also an enchantment (rule 205.1b), so enchantment removal, enchantment counts and constellation see them.',
  },
  'Encroaching Mycosynth': {
    effects: [{ kind: 'addTypes', types: ['artifact'], who: 'yoursNonland', when: 'static' }],
    notes: ['Your nonland permanents and permanent spells are artifacts too'],
    why: 'Your nonland permanents are artifacts, and so are the permanent spells you cast (cast triggers and cost reductions see it). Cards in your hand, library and graveyard are left as they are.',
  },
  Reconnaissance: {
    effects: [{ kind: 'removeFromCombat', when: 'activated', activation: act(cost(0), false) }],
    notes: ['{0}: Remove target attacking creature you control from combat and untap it'],
    why: 'Bots pull a blocked attacker that would die for nothing out of combat, and untap their attackers at end of combat.',
  },
  'Enhanced Surveillance': {
    effects: [
      { kind: 'surveilBoost', n: 2, when: 'static' },
      { kind: 'shuffleGraveyard', when: 'activated', activation: act(cost(0), false, { exileSelf: true }) },
    ],
    notes: ['Surveil looks at two more cards', 'Exile this: shuffle your graveyard into your library'],
    why: 'Bots exile it to shuffle their graveyard back once their library runs low.',
  },
  'The Ozolith': {
    effects: [
      { kind: 'ozolith', act: 'store', when: 'permLeaves', castFilter: 'creature' },
      { kind: 'ozolith', act: 'release', when: 'beginCombat' },
    ],
    notes: ['Keeps the counters of your creatures that leave', 'Beginning of combat on your turn: may move them onto target creature'],
    why: '+1/+1 counters (and -1/-1 counters, which go on an opponent\'s creature) are kept; other kinds of counters are left out.',
  },
  "Berserker's Frenzy": {
    effects: [{ kind: 'forceBlocks', when: 'resolve' }],
    notes: ['Roll two d20: 1-14 creatures that would lose a fight block if able; 15-20 you choose how creatures block'],
    why: 'The creatures chosen are the opponents\' creatures that would die blocking; on 15-20 each of them blocks an attacker that kills it. Bots cast it before their own combat.',
  },
  'Knowledge Pool': {
    effects: [
      { kind: 'knowledgePool', when: 'resolve' },
      { kind: 'knowledgePool', when: 'static' },
    ],
    notes: ['Each player exiles the top three cards of their library', 'A spell cast from hand is exiled; its caster may cast another card from the pool free'],
    why: 'The swap happens as the spell is cast, before anyone can respond (the trigger would resolve first anyway). Commanders cast from the command zone are not exiled.',
  },
  Solemnity: {
    effects: [{ kind: 'noCounters', when: 'static' }],
    notes: ['Players can\'t get counters; no counters on artifacts, creatures, enchantments or lands'],
    why: 'Stops poison, energy and experience counters, and +1/+1, -1/-1, charge, lore, stun and age counters on permanents. Planeswalkers keep their loyalty.',
  },
  'Nest of Scarabs': {
    effects: [{ kind: 'tokens', n: -1, power: 1, toughness: 1, keywords: [], subtypes: ['insect'], when: 'minusCounters' }],
    notes: ['Whenever you put -1/-1 counters on a creature: that many 1/1 Insects'],
    why: 'Counts -1/-1 counters from your spells and abilities, wither and infect damage, and persist.',
  },
  'Moxite Refinery': {
    effects: [{ kind: 'moveCounters', from: 'yours', when: 'activated', activation: act(cost(2), true, { sorcery: true }) }],
    notes: ['{2}, {T}: Move counters from one of your artifacts or creatures onto another (sorcery speed)'],
    why: 'The counters come from a permanent of yours that isn\'t using them (+1/+1 counters on a noncreature, charge counters nothing spends) and go onto your best creature or artifact.',
  },
  'Resourceful Defense': {
    effects: [
      { kind: 'moveCounters', from: 'subject', when: 'permLeaves' },
      { kind: 'moveCounters', from: 'yours', when: 'activated', activation: act(cost(4, [['W']]), false) },
    ],
    notes: ['When a permanent of yours with counters leaves: put them on another of yours', '{4}{W}: Move counters between your permanents'],
    why: '+1/+1 (and -1/-1) counters are moved; other kinds are left out. Bots use the activated ability to save counters from a permanent about to be removed.',
  },
  'Kill Switch': {
    effects: [{ kind: 'tapArtifacts', when: 'activated', activation: act(cost(2), true) }],
    notes: ['{2}, {T}: Tap all other artifacts; they stay tapped while this stays tapped'],
    why: 'Kill Switch untaps in its controller\'s next untap step, and the artifacts it held miss that untap step too (they all untap at once, rule 502.3). Bots use it when opponents have more artifacts working for them than they do.',
  },
};
