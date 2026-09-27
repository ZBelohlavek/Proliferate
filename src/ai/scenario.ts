// Builds Playstyle quiz questions from real board states.
//
// A game between your deck and others is played part-way with the internal
// board engine (src/engine/game.ts), frozen at the start of one of your turns,
// and turned into a yes/no decision that maps onto a Forge AI setting (see
// src/ai/forgeProfile.ts). Only the board comes from the internal engine;
// all simulation results come from Forge.

import { Game, type Perm, type Player } from '../engine/game';
import type { SimCard, SimDeck } from '../engine/types';
import { shuffle } from '../sim/pods';
import type { ProfileAnswer, QuestionKind } from './forgeProfile';

export interface PermView {
  name: string;
  count: number;
  pt: string | null;
  tapped: boolean;
  sick: boolean;
  token: boolean;
  commander: boolean;
  keywords: string[];
  detail: string;
  /** Part of the situation the question is about. */
  focus: boolean;
}

export interface PlayerView {
  seat: number;
  you: boolean;
  deckName: string;
  commander: string;
  life: number;
  hand: number;
  library: number;
  lands: number;
  untappedLands: number;
  creatures: PermView[];
  others: PermView[];
  commanderDamage: string[];
  focus: boolean;
}

export interface HandCardView {
  name: string;
  cost: string;
  detail: string;
  /** A card we added for the question ("you're holding a counterspell"). */
  hypothetical: boolean;
}

export interface Scenario {
  kind: QuestionKind;
  round: number;
  /** What's happening, in one or two sentences. */
  situation: string;
  question: string;
  yesLabel: string;
  noLabel: string;
  context: ProfileAnswer['context'];
  players: PlayerView[];
  hand: HandCardView[];
  mana: number;
}

export const QUESTION_KINDS: QuestionKind[] = ['attackTrade', 'counter', 'trick', 'blockTrade', 'destroyArtifact'];

function costText(card: SimCard): string {
  const parts: string[] = [];
  for (let i = 0; i < card.cost.x; i++) parts.push('X');
  if (card.cost.generic) parts.push(String(card.cost.generic));
  for (const pip of card.cost.pips) parts.push(pip.join('/'));
  return parts.length ? parts.map((p) => `{${p}}`).join('') : '{0}';
}

const pt = (g: Game, p: Perm) => `${g.power(p)}/${g.toughness(p)}`;

/**
 * Play random games with your deck until one reaches a moment where the
 * question makes sense. `pool` supplies opponents.
 */
export function makeScenario(pool: SimDeck[], yours: SimDeck, kind: QuestionKind, podSize = 4): Scenario | null {
  const others = pool.filter((d) => d.id !== yours.id);
  if (!others.length) return null;
  for (let attempt = 0; attempt < 80; attempt++) {
    const opponents = shuffle([...others]).slice(0, Math.max(1, Math.min(podSize - 1, others.length)));
    const pod = shuffle([yours, ...opponents]);
    const seat = pod.indexOf(yours);
    // Later rounds give fuller boards (and lower life totals for the blocking question).
    const round = kind === 'blockTrade' ? 4 + Math.floor(Math.random() * 10) : 3 + Math.floor(Math.random() * 7);
    const game = new Game(pod, (Math.random() * 2 ** 32) >>> 0);
    if (!game.advanceTo(round, seat)) continue;
    const scenario = build(game, game.players[seat], kind, round);
    if (scenario) return scenario;
  }
  return null;
}

function build(game: Game, me: Player, kind: QuestionKind, round: number): Scenario | null {
  const focus = new Set<Perm>();
  let focusPlayer: Player | null = null;
  const extraHand: HandCardView[] = [];
  let situation = '';
  let question = '';
  let yesLabel = '';
  let noLabel = '';
  const context: ProfileAnswer['context'] = {};

  const untappedLands = (p: Player) => p.battlefield.filter((x) => x.landInfo && !x.tapped).length;
  const pick = <T,>(xs: T[]): T => xs[Math.floor(Math.random() * xs.length)];
  const trades = (a: Perm, b: Perm) => game.kills(a, b) && game.kills(b, a) && !game.survives(a, b) && !game.survives(b, a);

  if (kind === 'attackTrade') {
    // One of your attackers, and an opponent's untapped creature that would block and trade with it.
    const options: { a: Perm; b: Perm; o: Player }[] = [];
    for (const a of game.canAttackWith(me)) {
      for (const o of game.opponents(me)) {
        for (const b of o.battlefield) if (b.card.isCreature && game.canBlock(b, a) && trades(a, b)) options.push({ a, b, o });
      }
    }
    if (!options.length) return null;
    const { a, b, o } = pick(options);
    focus.add(a).add(b);
    focusPlayer = o;
    const open = untappedLands(o);
    context.oppHasMana = open >= 2;
    situation = `Your ${a.card.name} (${pt(game, a)}) can attack ${o.deck.name}. Their untapped ${b.card.name} (${pt(game, b)}) could block it, and both would die. They have ${open} untapped land${open === 1 ? '' : 's'}.`;
    question = `Do you attack ${o.deck.name} with ${a.card.name}?`;
    yesLabel = 'Attack';
    noLabel = "Don't attack with it";
  } else if (kind === 'blockTrade') {
    // An opponent's creature attacks you; you have a blocker that would trade with it.
    const options: { x: Perm; y: Perm; o: Player }[] = [];
    for (const o of game.opponents(me)) {
      for (const x of o.battlefield) {
        if (!x.card.isCreature || game.power(x) < 2) continue;
        for (const y of me.battlefield) if (y.card.isCreature && !y.tapped && game.canBlock(y, x) && trades(x, y)) options.push({ x, y, o });
      }
    }
    if (!options.length) return null;
    const { x, y, o } = pick(options);
    focus.add(x).add(y);
    focusPlayer = o;
    context.life = me.life;
    situation = `${o.deck.name} attacks you with ${x.card.name} (${pt(game, x)}). You're at ${me.life} life. Your ${y.card.name} (${pt(game, y)}) can block it, and both would die.`;
    question = `Do you block with ${y.card.name}, or take ${game.power(x)} damage?`;
    yesLabel = `Block with ${y.card.name}`;
    noLabel = `Take ${game.power(x)} damage`;
  } else if (kind === 'trick') {
    const attackers = game.canAttackWith(me);
    const opps = game.opponents(me).filter((o) => o.battlefield.some((p) => p.card.isCreature && !p.tapped));
    if (!attackers.length || !opps.length) return null;
    const a = pick(attackers);
    const o = pick(opps);
    // Use a real combat trick from your deck if you have one.
    const own = [...me.hand, ...me.library].find((c) => c.isInstant && c.effects.some((e) => e.kind === 'pump'));
    const trick = own?.name ?? 'Giant Growth';
    const pumpText = own?.notes.find((n) => /^Combat trick/.test(n))?.replace(/^Combat trick /, '') ?? '+3/+3';
    focus.add(a);
    focusPlayer = o;
    if (!own || !me.hand.includes(own)) extraHand.push({ name: trick, cost: own ? costText(own) : '{G}', detail: `Combat trick: ${pumpText} until end of turn`, hypothetical: true });
    situation = `You attack ${o.deck.name} with ${a.card.name} (${pt(game, a)}). They have untapped creatures that could block. You're holding ${trick} (${pumpText}) and have the mana for it.`;
    question = `Do you cast ${trick} now, or wait to see how they block?`;
    yesLabel = 'Cast it now';
    noLabel = 'Wait for blocks';
  } else if (kind === 'counter') {
    // An opponent casts a real card from their deck; you're holding a counterspell.
    const want = pick([1, 2, 3 + Math.floor(Math.random() * 4)]);
    const casts: { o: Player; card: SimCard }[] = [];
    for (const o of game.opponents(me)) {
      for (const c of [...o.hand, ...o.library]) if (!c.isLand && c.cmc === want) casts.push({ o, card: c });
    }
    if (!casts.length) return null;
    const { o, card } = pick(casts);
    focusPlayer = o;
    context.manaValue = card.cmc;
    extraHand.push({ name: 'Counterspell', cost: '{U}{U}', detail: 'Counter target spell.', hypothetical: true });
    const what = card.notes.filter((n) => !/^Creature/.test(n) && !/^Not modeled/.test(n)).slice(0, 2).join('; ');
    situation = `${o.deck.name} casts ${card.name} (mana value ${card.cmc}, ${card.typeLine}${what ? ` — ${what}` : ''}). You're holding Counterspell with two blue mana open.`;
    question = `Do you counter ${card.name}?`;
    yesLabel = 'Counter it';
    noLabel = 'Let it resolve';
  } else {
    // destroyArtifact: an opponent's non-creature artifact or enchantment, and you hold removal for it.
    const targets: { o: Player; p: Perm }[] = [];
    for (const o of game.opponents(me)) {
      for (const p of o.battlefield) if (!p.landInfo && !p.card.isCreature && (p.card.isArtifact || p.card.isEnchantment)) targets.push({ o, p });
    }
    if (!targets.length) return null;
    const { o, p } = pick(targets);
    focus.add(p);
    focusPlayer = o;
    extraHand.push({ name: "Nature's Claim", cost: '{G}', detail: 'Destroy target artifact or enchantment. Its controller gains 4 life.', hypothetical: true });
    const what = p.card.notes.filter((n) => !/^Not modeled/.test(n)).slice(0, 2).join('; ');
    situation = `${o.deck.name} controls ${p.card.name}${what ? ` (${what})` : ''}. You're holding Nature's Claim, which can destroy an artifact or enchantment.`;
    question = `Do you destroy ${p.card.name} now, or save the removal for later?`;
    yesLabel = 'Destroy it now';
    noLabel = 'Save it';
  }

  const permView = (perms: Perm[]): PermView[] => {
    const groups = new Map<string, PermView>();
    for (const perm of perms) {
      const ptText = perm.card.isCreature ? pt(game, perm) : null;
      const isFocus = focus.has(perm);
      const key = `${perm.card.name}|${ptText}|${perm.tapped}|${perm.sick}|${perm.token}|${isFocus}`;
      const g = groups.get(key);
      if (g) {
        g.count++;
        continue;
      }
      const keywords = ['flying', 'trample', 'deathtouch', 'lifelink', 'double strike', 'first strike', 'menace', 'vigilance', 'haste', 'hexproof', 'indestructible', 'unblockable', 'reach']
        .filter((k) => game.hasKw(perm, k));
      groups.set(key, {
        name: perm.card.name,
        count: 1,
        pt: ptText,
        tapped: perm.tapped,
        sick: perm.sick,
        token: perm.token,
        commander: perm.isCommander,
        keywords,
        detail: [perm.card.typeLine, ...perm.card.notes.filter((n) => !/^Not modeled/.test(n))].filter(Boolean).join(' · '),
        focus: isFocus,
      });
    }
    return [...groups.values()];
  };

  const players: PlayerView[] = game.players.filter((p) => p.alive).map((p) => ({
    seat: p.seat,
    you: p === me,
    deckName: p.deck.name,
    commander: p.deck.commanders.map((c) => c.name).join(' & '),
    life: p.life,
    hand: p.hand.length,
    library: p.library.length,
    lands: p.battlefield.filter((x) => x.landInfo).length,
    untappedLands: untappedLands(p),
    creatures: permView(p.battlefield.filter((x) => x.card.isCreature)),
    others: permView(p.battlefield.filter((x) => !x.card.isCreature && !x.landInfo)),
    commanderDamage: [...p.commanderDamage.entries()].filter(([, v]) => v > 0).map(([k, v]) => `${v} from ${k.split(':')[1]}`),
    focus: p === focusPlayer,
  }));

  const hand: HandCardView[] = [
    ...me.hand.map((c) => ({ name: c.name, cost: c.isLand ? 'land' : costText(c), detail: [c.typeLine, ...c.notes.filter((n) => !/^Not modeled/.test(n))].join(' · '), hypothetical: false })),
    ...extraHand,
  ];

  return { kind, round, situation, question, yesLabel, noLabel, context, players, hand, mana: game.availableMana(me) };
}
