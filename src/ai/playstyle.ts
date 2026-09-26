// Learns how *you* make decisions from the Playstyle quiz, so the quick
// engine can pilot decks your way.
//
// Each decision (which permanent is the biggest threat, which player to
// attack, what to cast) is a choice between options. Every option is
// described by a few numbers ("features"), and the AI scores each option as a
// weighted sum of its features, then picks the highest score.
//
// Feature 0 is always the built-in AI's own score for the option, and the
// default weights put all the weight on it — so with no quiz answers, the AI
// plays exactly as before. Each answer says "you preferred this option over
// the others". We fit the weights with a conditional logit model (logistic
// regression over choice sets), pulled toward the defaults so a handful of
// answers can't swing things wildly.

export type DecisionKind = 'threat' | 'attack' | 'cast';

export interface FeatureInfo {
  key: string;
  /** How to describe a positive / negative weight change in plain English. */
  more: string;
  less: string;
}

export const FEATURES: Record<DecisionKind, FeatureInfo[]> = {
  threat: [
    { key: 'ai', more: '', less: '' },
    { key: 'power', more: 'Big creatures worry you more', less: 'Big creatures worry you less than the AI thinks' },
    { key: 'evasive', more: 'You rate evasive creatures (flying, unblockable) as bigger threats', less: 'Evasion matters less to you' },
    { key: 'commander', more: 'You focus on commanders', less: 'You care less about commanders than the AI does' },
    { key: 'engine', more: 'You rate engines (repeating triggers, anthems) as bigger threats', less: 'Engines worry you less than the AI thinks' },
    { key: 'mana', more: 'You go after mana rocks and dorks', less: 'You ignore mana sources' },
    { key: 'creature', more: 'You worry about creatures more than other permanents', less: 'Non-creature permanents worry you more than creatures' },
    { key: 'token', more: 'Tokens worry you', less: 'You ignore tokens' },
    { key: 'leader', more: "You target the table leader's stuff", less: "The leader's board doesn't draw your attention" },
    { key: 'lowLife', more: 'You go after permanents of players who are low on life', less: 'You leave players who are low on life alone' },
  ],
  attack: [
    { key: 'ai', more: '', less: '' },
    { key: 'lowLife', more: 'You go after players with low life', less: 'You spread damage rather than finishing low players' },
    { key: 'lethal', more: 'You take kills whenever you can', less: 'You pass up kills more than the AI' },
    { key: 'board', more: 'You attack whoever has the biggest board', less: 'You avoid players with big boards' },
    { key: 'blockers', more: 'You attack into blockers anyway', less: 'You avoid attacking into blockers' },
    { key: 'leader', more: 'You attack the table leader', less: "You don't gang up on the leader" },
    { key: 'commanderDamage', more: 'You chase commander damage kills', less: "You don't chase commander damage" },
    { key: 'revenge', more: 'You hit back at whoever attacked you', less: "You don't hold grudges" },
  ],
  cast: [
    { key: 'ai', more: '', less: '' },
    { key: 'ramp', more: 'You prioritise ramp', less: 'You play threats over ramp' },
    { key: 'draw', more: 'You prioritise card draw', less: 'You deprioritise card draw' },
    { key: 'removal', more: 'You use removal eagerly', less: 'You hold removal for bigger threats' },
    { key: 'wipe', more: 'You wipe the board readily', less: 'You hold on to board wipes' },
    { key: 'creature', more: 'You like developing creatures', less: 'You prefer non-creature spells' },
    { key: 'commander', more: 'You get your commander out early', less: 'You hold your commander back' },
    { key: 'bigThreat', more: 'You slam your biggest threats', less: 'You avoid over-committing big threats' },
    { key: 'manaUsed', more: 'You like spending all your mana', less: 'You prefer cheaper plays' },
    { key: 'earlyRamp', more: 'You ramp hard in the first few turns', less: "You don't prioritise early ramp" },
    { key: 'pass', more: 'You often hold up mana instead of casting', less: 'You rarely pass with mana up' },
  ],
};

export type Weights = Record<DecisionKind, number[]>;

/** One quiz answer: the feature vectors of every option, and which one you picked. */
export interface Answer {
  kind: DecisionKind;
  options: number[][];
  chosen: number;
  /** The option the default AI picked, for the agreement score. */
  aiChoice: number;
  at: number;
}

export function defaultWeights(): Weights {
  const w = (kind: DecisionKind): number[] => FEATURES[kind].map((f) => (f.key === 'ai' ? 1 : 0));
  const cast = w('cast');
  cast[FEATURES.cast.findIndex((f) => f.key === 'pass')] = -3; // the default AI never holds mana on purpose
  return { threat: w('threat'), attack: w('attack'), cast };
}

export function utility(w: number[], x: number[]): number {
  let s = 0;
  for (let i = 0; i < w.length; i++) s += w[i] * (x[i] ?? 0);
  return s;
}

export function argmax(w: number[], options: number[][]): number {
  let best = 0;
  for (let i = 1; i < options.length; i++) if (utility(w, options[i]) > utility(w, options[best])) best = i;
  return best;
}

/**
 * Conditional-logit fit by gradient ascent:
 *   maximise  Σ log softmax(w·x)[chosen]  −  λ/2 · |w − w0|²
 */
function fitKind(answers: Answer[], w0: number[], lambda = 1): number[] {
  const w = [...w0];
  const n = answers.length;
  if (!n) return w;
  for (let iter = 0; iter < 500; iter++) {
    // Gradient of the (per-answer averaged) objective.
    const grad = w.map((wi, i) => (-lambda * (wi - w0[i])) / n);
    for (const a of answers) {
      const u = a.options.map((x) => utility(w, x));
      const max = Math.max(...u);
      const e = u.map((v) => Math.exp(v - max));
      const z = e.reduce((s, v) => s + v, 0);
      for (let k = 0; k < a.options.length; k++) {
        const p = e[k] / z;
        const indicator = k === a.chosen ? 1 : 0;
        for (let i = 0; i < w.length; i++) grad[i] += ((indicator - p) * (a.options[k][i] ?? 0)) / n;
      }
    }
    for (let i = 0; i < w.length; i++) w[i] += 0.5 * grad[i];
  }
  return w;
}

export function fitWeights(answers: Answer[]): Weights {
  const w0 = defaultWeights();
  return {
    threat: fitKind(answers.filter((a) => a.kind === 'threat'), w0.threat),
    attack: fitKind(answers.filter((a) => a.kind === 'attack'), w0.attack),
    cast: fitKind(answers.filter((a) => a.kind === 'cast'), w0.cast),
  };
}

/**
 * How often the default AI and your fitted profile pick what you picked.
 * The profile is scored leave-one-out (fitted without the answer it's
 * predicting), so it can't just memorise your answers.
 */
export function agreement(answers: Answer[]): { n: number; defaultAi: number; yourStyle: number } | null {
  if (answers.length < 5) return null;
  let def = 0;
  let mine = 0;
  const w0 = defaultWeights();
  answers.forEach((a, i) => {
    if (a.aiChoice === a.chosen) def++;
    const others = answers.filter((b, j) => j !== i && b.kind === a.kind);
    const w = fitKind(others, w0[a.kind]);
    if (argmax(w, a.options) === a.chosen) mine++;
  });
  return { n: answers.length, defaultAi: def / answers.length, yourStyle: mine / answers.length };
}

/** The biggest ways your weights differ from the default AI, in words. */
export function describe(weights: Weights, answers: Answer[]): { kind: DecisionKind; text: string; strength: number }[] {
  const w0 = defaultWeights();
  const out: { kind: DecisionKind; text: string; strength: number }[] = [];
  for (const kind of Object.keys(FEATURES) as DecisionKind[]) {
    if (answers.filter((a) => a.kind === kind).length < 3) continue;
    FEATURES[kind].forEach((f, i) => {
      if (f.key === 'ai') return;
      const delta = weights[kind][i] - w0[kind][i];
      if (Math.abs(delta) < 0.25) return;
      out.push({ kind, text: delta > 0 ? f.more : f.less, strength: Math.abs(delta) });
    });
  }
  return out.sort((a, b) => b.strength - a.strength).slice(0, 8);
}

const STORAGE_KEY = 'proliferate.playstyle.v1';

export function loadAnswers(): Answer[] {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]');
  } catch {
    return [];
  }
}

export function saveAnswers(answers: Answer[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(answers));
  } catch {
    /* storage unavailable */
  }
}
