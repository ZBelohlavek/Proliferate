// Builds quiz scenarios: play a quick-engine game with your deck up to the
// start of one of your turns, freeze it, and ask what you'd do.

import { Game, type Perm, type Player } from '../engine/game';
import type { SimDeck } from '../engine/types';
import { argmax, defaultWeights, type DecisionKind } from './playstyle';
import { shuffle } from '../sim/pods';

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
  /** Option index if this permanent can be picked in the current question. */
  option: number | null;
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
  creatures: PermView[];
  others: PermView[];
  commanderDamage: string[];
  attackedYouLastRound: boolean;
  /** Option index if this player can be picked (attack question). */
  option: number | null;
}

export interface HandCardView {
  name: string;
  cost: string;
  detail: string;
  option: number | null;
}

export interface Scenario {
  kind: DecisionKind;
  round: number;
  prompt: string;
  players: PlayerView[];
  hand: HandCardView[];
  mana: number;
  attackers: string[];
  /** Feature vector per option. */
  options: number[][];
  optionLabels: string[];
  /** Which option the default AI picks. */
  aiChoice: number;
  /** Index of the "hold mana" option for cast questions. */
  passOption: number | null;
}

const PROMPTS: Record<DecisionKind, string> = {
  threat: 'Which opposing permanent is the biggest threat to you? (Click it.)',
  attack: 'You are about to attack. Which player do you attack?',
  cast: 'It is your main phase. What do you cast first?',
};

function costText(card: { cost: { generic: number; pips: string[][]; x: number } }): string {
  const parts: string[] = [];
  for (let i = 0; i < card.cost.x; i++) parts.push('X');
  if (card.cost.generic) parts.push(String(card.cost.generic));
  for (const pip of card.cost.pips) parts.push(pip.join('/'));
  return parts.length ? parts.map((p) => `{${p}}`).join('') : '{0}';
}

/**
 * Try random games until one reaches a moment where the question makes sense.
 * `pool` supplies opponents; `yours` is the deck you're piloting.
 */
export function makeScenario(pool: SimDeck[], yours: SimDeck, kind: DecisionKind, podSize = 4): Scenario | null {
  const others = pool.filter((d) => d.id !== yours.id);
  if (!others.length) return null;

  for (let attempt = 0; attempt < 60; attempt++) {
    const opponents = shuffle([...others]).slice(0, Math.max(1, Math.min(podSize - 1, others.length)));
    const pod = shuffle([yours, ...opponents]);
    const seat = pod.indexOf(yours);
    const round = 3 + Math.floor(Math.random() * 6);
    const game = new Game(pod, (Math.random() * 2 ** 32) >>> 0);
    if (!game.advanceTo(round, seat)) continue;
    const me = game.players[seat];
    const scenario = buildScenario(game, me, kind, round);
    if (scenario) return scenario;
  }
  return null;
}

function buildScenario(game: Game, me: Player, kind: DecisionKind, round: number): Scenario | null {
  const options: number[][] = [];
  const optionLabels: string[] = [];
  const permOption = new Map<Perm, number>();
  const playerOption = new Map<Player, number>();
  const handOption = new Map<string, number>();
  let passOption: number | null = null;
  let attackers: string[] = [];

  if (kind === 'threat') {
    // Collapse identical permanents (e.g. a pile of tokens) into one option.
    const seen = new Map<string, number>();
    for (const opt of game.threatOptions(me)) {
      const key = `${opt.value.seat}|${opt.value.card.name}|${opt.value.token}|${opt.x.join(',')}`;
      const existing = seen.get(key);
      if (existing !== undefined) {
        permOption.set(opt.value, existing);
        continue;
      }
      seen.set(key, options.length);
      permOption.set(opt.value, options.length);
      options.push(opt.x);
      optionLabels.push(opt.value.card.name);
    }
    if (options.length < 3) return null;
  } else if (kind === 'attack') {
    const canAttack = game.canAttackWith(me);
    if (!canAttack.length || game.opponents(me).length < 2) return null;
    attackers = canAttack.map((a) => `${a.card.name} ${game.power(a)}/${game.toughness(a)}`);
    for (const opt of game.attackOptions(me, canAttack)) {
      playerOption.set(opt.value, options.length);
      options.push(opt.x);
      optionLabels.push(opt.value.deck.name);
    }
  } else {
    const castOpts = game.castOptions(me);
    if (castOpts.length < 3) return null; // at least two spells plus "hold mana"
    castOpts.forEach((opt) => {
      if (opt.value === null) {
        passOption = options.length;
        optionLabels.push('Hold up mana / cast nothing');
      } else {
        handOption.set(opt.value.fromCommandZone ? `cz:${opt.value.card.name}` : opt.value.card.name, options.length);
        optionLabels.push(opt.value.card.name);
      }
      options.push(opt.x);
    });
  }

  const permView = (perms: Perm[]): PermView[] => {
    const groups = new Map<string, PermView>();
    for (const perm of perms) {
      const pt = perm.card.isCreature ? `${game.power(perm)}/${game.toughness(perm)}` : null;
      const key = `${perm.card.name}|${pt}|${perm.tapped}|${perm.sick}|${perm.token}|${permOption.get(perm) ?? ''}`;
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
        pt,
        tapped: perm.tapped,
        sick: perm.sick,
        token: perm.token,
        commander: perm.isCommander,
        keywords,
        detail: [perm.card.typeLine, ...perm.card.notes].filter(Boolean).join(' · '),
        option: permOption.get(perm) ?? null,
      });
    }
    return [...groups.values()];
  };

  const players: PlayerView[] = game.players.filter((p) => p.alive).map((p) => {
    const lastAttack = me.attackedBy.get(p.seat);
    return {
      seat: p.seat,
      you: p === me,
      deckName: p.deck.name,
      commander: p.deck.commanders.map((c) => c.name).join(' & '),
      life: p.life,
      hand: p.hand.length,
      library: p.library.length,
      lands: p.battlefield.filter((x) => x.landInfo).length,
      creatures: permView(p.battlefield.filter((x) => x.card.isCreature)),
      others: permView(p.battlefield.filter((x) => !x.card.isCreature && !x.landInfo)),
      commanderDamage: [...p.commanderDamage.entries()].filter(([, v]) => v > 0).map(([k, v]) => `${v} from ${k.split(':')[1]}`),
      attackedYouLastRound: p !== me && lastAttack !== undefined && lastAttack >= round - 1,
      option: playerOption.get(p) ?? null,
    };
  });

  const hand: HandCardView[] = [
    ...me.commandZone.map((c) => ({ name: `${c.name} (command zone)`, cost: costText(c), detail: c.notes.join(' · '), option: handOption.get(`cz:${c.name}`) ?? null })),
    ...me.hand.map((c) => ({ name: c.name, cost: c.isLand ? 'land' : costText(c), detail: [c.typeLine, ...c.notes].join(' · '), option: handOption.get(c.name) ?? null })),
  ];

  return {
    kind,
    round,
    prompt: PROMPTS[kind],
    players,
    hand,
    mana: game.availableMana(me),
    attackers,
    options,
    optionLabels,
    aiChoice: argmax(defaultWeights()[kind], options),
    passOption,
  };
}
