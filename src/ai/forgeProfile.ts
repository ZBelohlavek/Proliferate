// Turns Playstyle quiz answers into a Forge AI profile.
//
// Forge's AI reads ~300 settings from a profile file (forge/res/ai/*.ai).
// Each quiz question is a yes/no decision in a real board state that maps
// onto one of those settings, e.g. "attack into a blocker that trades?" ->
// CHANCE_TO_ATTACK_INTO_TRADE. We estimate how often you say yes in each kind
// of situation, starting from Forge's Default value and moving toward your
// answers as they accumulate (a Beta prior worth PRIOR_WEIGHT answers).

export type QuestionKind = 'attackTrade' | 'counter' | 'trick' | 'blockTrade' | 'destroyArtifact';

export interface ProfileAnswer {
  kind: QuestionKind;
  /** true = the "aggressive / act now" option (attack, counter, cast now, block, destroy). */
  yes: boolean;
  /** Extra context that decides which setting the answer feeds. */
  context: {
    /** counter: mana value of the spell being countered. */
    manaValue?: number;
    /** attackTrade: the defending player had untapped mana. */
    oppHasMana?: boolean;
    /** blockTrade: your life when deciding. */
    life?: number;
  };
  at: number;
}

/** A group of answers that sets one Forge probability. */
interface Rate {
  key: string;
  label: string;
  /** Forge Default's value, as a 0–1 chance. */
  prior: number;
  filter: (a: ProfileAnswer) => boolean;
}

const PRIOR_WEIGHT = 4;

const RATES: Rate[] = [
  { key: 'CHANCE_TO_ATTACK_INTO_TRADE', label: 'Attack into a blocker that would trade', prior: 0, filter: (a) => a.kind === 'attackTrade' },
  { key: 'CHANCE_TO_ATKTRADE_WHEN_OPP_HAS_MANA', label: '…when the defender has mana open', prior: 0.3, filter: (a) => a.kind === 'attackTrade' && !!a.context.oppHasMana },
  { key: 'CHANCE_TO_COUNTER_CMC_1', label: 'Counter a 1-mana spell', prior: 0.3, filter: (a) => a.kind === 'counter' && (a.context.manaValue ?? 0) <= 1 },
  { key: 'CHANCE_TO_COUNTER_CMC_2', label: 'Counter a 2-mana spell', prior: 0.75, filter: (a) => a.kind === 'counter' && a.context.manaValue === 2 },
  { key: 'CHANCE_TO_COUNTER_CMC_3', label: 'Counter a 3+ mana spell', prior: 1, filter: (a) => a.kind === 'counter' && (a.context.manaValue ?? 0) >= 3 },
  { key: 'CHANCE_TO_HOLD_COMBAT_TRICKS_UNTIL_BLOCK', label: 'Wait for blocks before a combat trick', prior: 0.65, filter: (a) => a.kind === 'trick' },
  { key: 'MIN_CHANCE_TO_RANDOMLY_TRADE_ON_BLOCK', label: 'Block and trade at healthy life', prior: 0.3, filter: (a) => a.kind === 'blockTrade' && (a.context.life ?? 40) > 20 },
  { key: 'MAX_CHANCE_TO_RANDOMLY_TRADE_ON_BLOCK', label: 'Block and trade at low life', prior: 0.7, filter: (a) => a.kind === 'blockTrade' && (a.context.life ?? 40) <= 20 },
  { key: 'ACTIVELY_DESTROY_ARTS_AND_NONAURA_ENCHS', label: 'Destroy artifacts/enchantments right away', prior: 0.75, filter: (a) => a.kind === 'destroyArtifact' },
];

/** "trick" answers record yes = cast now, but the Forge setting is the chance to *wait*. */
const INVERTED = new Set(['CHANCE_TO_HOLD_COMBAT_TRICKS_UNTIL_BLOCK']);

export interface RateEstimate {
  key: string;
  label: string;
  answers: number;
  /** Your estimated chance (0–1), blended with Forge's default. */
  value: number;
  forgeDefault: number;
}

export function estimateRates(answers: ProfileAnswer[]): RateEstimate[] {
  return RATES.map((r) => {
    const mine = answers.filter(r.filter);
    const yes = mine.filter((a) => (INVERTED.has(r.key) ? !a.yes : a.yes)).length;
    return {
      key: r.key,
      label: r.label,
      answers: mine.length,
      value: (yes + r.prior * PRIOR_WEIGHT) / (mine.length + PRIOR_WEIGHT),
      forgeDefault: r.prior,
    };
  });
}

/** Settings to write into the "You" profile, on top of Forge's Default profile. */
export function profileOverrides(answers: ProfileAnswer[]): Record<string, string> {
  const est = Object.fromEntries(estimateRates(answers).map((e) => [e.key, e.value]));
  const pct = (v: number) => String(Math.round(v * 100));
  const out: Record<string, string> = {
    CHANCE_TO_ATTACK_INTO_TRADE: pct(est.CHANCE_TO_ATTACK_INTO_TRADE),
    CHANCE_TO_ATKTRADE_WHEN_OPP_HAS_MANA: pct(est.CHANCE_TO_ATKTRADE_WHEN_OPP_HAS_MANA),
    // Aggressive players also attack into trades when tapped out, and play the aggro game plan.
    ATTACK_INTO_TRADE_WHEN_TAPPED_OUT: String(est.CHANCE_TO_ATTACK_INTO_TRADE >= 0.5),
    PLAY_AGGRO: String(est.CHANCE_TO_ATTACK_INTO_TRADE >= 0.6),
    CHANCE_TO_COUNTER_CMC_1: pct(est.CHANCE_TO_COUNTER_CMC_1),
    CHANCE_TO_COUNTER_CMC_2: pct(est.CHANCE_TO_COUNTER_CMC_2),
    CHANCE_TO_COUNTER_CMC_3: pct(est.CHANCE_TO_COUNTER_CMC_3),
    TRY_TO_HOLD_COMBAT_TRICKS_UNTIL_BLOCK: String(est.CHANCE_TO_HOLD_COMBAT_TRICKS_UNTIL_BLOCK >= 0.2),
    CHANCE_TO_HOLD_COMBAT_TRICKS_UNTIL_BLOCK: pct(est.CHANCE_TO_HOLD_COMBAT_TRICKS_UNTIL_BLOCK),
    ENABLE_RANDOM_FAVORABLE_TRADES_ON_BLOCK: 'true',
    MIN_CHANCE_TO_RANDOMLY_TRADE_ON_BLOCK: pct(Math.min(est.MIN_CHANCE_TO_RANDOMLY_TRADE_ON_BLOCK, est.MAX_CHANCE_TO_RANDOMLY_TRADE_ON_BLOCK)),
    MAX_CHANCE_TO_RANDOMLY_TRADE_ON_BLOCK: pct(Math.max(est.MIN_CHANCE_TO_RANDOMLY_TRADE_ON_BLOCK, est.MAX_CHANCE_TO_RANDOMLY_TRADE_ON_BLOCK)),
    ACTIVELY_DESTROY_ARTS_AND_NONAURA_ENCHS: String(est.ACTIVELY_DESTROY_ARTS_AND_NONAURA_ENCHS >= 0.5),
  };
  return out;
}

const STORAGE_KEY = 'proliferate.forgeProfileAnswers.v1';

export function loadProfileAnswers(): ProfileAnswer[] {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]');
  } catch {
    return [];
  }
}

export function saveProfileAnswers(answers: ProfileAnswer[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(answers));
  } catch {
    /* storage unavailable */
  }
}
