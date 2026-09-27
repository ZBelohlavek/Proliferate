import { useCallback, useEffect, useMemo, useState } from 'react';
import type { SimDeck } from '../engine/types';
import { estimateRates, type ProfileAnswer, type QuestionKind } from '../ai/forgeProfile';
import { makeScenario, QUESTION_KINDS, type Scenario } from '../ai/scenario';
import { BoardView } from './BoardView';
import { Help } from './Help';
import { pct } from './format';

interface Props {
  decks: SimDeck[];
  selected: string[];
  answers: ProfileAnswer[];
  onAnswer: (a: ProfileAnswer) => void;
  onResetAnswers: () => void;
  usingProfile: boolean;
  onUseProfile: (on: boolean) => void;
}

/**
 * The Playstyle quiz: an endless stream of real board states, each asking one
 * yes/no decision. Answers quietly tune a Forge AI personality ("You").
 */
export function PlaystylePanel({ decks, selected, answers, onAnswer, onResetAnswers, usingProfile, onUseProfile }: Props) {
  const [deckId, setDeckId] = useState<string>(() => selected[0] ?? decks[0]?.id ?? '');
  const [scenario, setScenario] = useState<Scenario | null>(null);
  const [failed, setFailed] = useState(false);
  const [flash, setFlash] = useState(false);
  const deck = decks.find((d) => d.id === deckId) ?? decks[0];
  const rates = useMemo(() => estimateRates(answers), [answers]);

  const next = useCallback(() => {
    if (!deck) return;
    // Weighted random order: any situation can come next (so there's no pattern to
    // play along with), but ones you've answered less are a bit more likely.
    const counts = new Map<QuestionKind, number>(QUESTION_KINDS.map((k) => [k, answers.filter((a) => a.kind === k).length]));
    const min = Math.min(...counts.values());
    const pool = QUESTION_KINDS.map((k) => ({ k, w: 1 / (1 + (counts.get(k)! - min) / 3) }));
    const order: QuestionKind[] = [];
    while (pool.length) {
      let r = Math.random() * pool.reduce((s, x) => s + x.w, 0);
      const i = pool.findIndex((x) => (r -= x.w) <= 0);
      order.push(pool.splice(i === -1 ? pool.length - 1 : i, 1)[0].k);
    }
    for (const kind of order) {
      const s = makeScenario(decks, deck, kind);
      if (s) {
        setScenario(s);
        setFailed(false);
        return;
      }
    }
    setScenario(null);
    setFailed(true);
  }, [deck, decks, answers]);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => next(), [deckId]);

  const answer = useCallback((yes: boolean) => {
    if (!scenario) return;
    onAnswer({ kind: scenario.kind, yes, context: scenario.context, at: Date.now() });
    setFlash(true);
    setTimeout(() => setFlash(false), 400);
    next();
  }, [scenario, onAnswer, next]);

  // Keys 1 / 2 answer, S skips — handy for answering lots of questions quickly.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === '1') answer(true);
      else if (e.key === '2') answer(false);
      else if (e.key.toLowerCase() === 's') next();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [answer, next]);

  if (decks.length < 2) return <section className="panel empty"><p>Import at least two decks — the quiz needs opponents.</p></section>;

  return (
    <>
      <section className="panel">
        <div className="panel-head">
          <h2>Your Forge personality <Help>
            Every question is a real situation from a game with your deck. Your answers tune a Forge AI profile called <strong>You</strong>: how often you attack into trades, counter spells (by mana value), hold combat tricks until blocks, trade when blocking (at high and low life) and destroy artifacts/enchantments.
            <br /><br />It starts as Forge&apos;s Default AI and moves toward your choices as you answer. Answer honestly — there are no right answers, and the more you answer the closer it gets.
          </Help></h2>
          <label className="toggle">
            <input type="checkbox" checked={usingProfile} onChange={(e) => onUseProfile(e.target.checked)} />
            Use my personality in simulations
          </label>
        </div>
        <p className="muted small">
          {answers.length} answer{answers.length === 1 ? '' : 's'} so far. Keep going as long as you like — every answer refines it. Forge picks it up the next time a run starts.
          {answers.length > 0 && <> <button className="link danger" onClick={() => confirm(`Forget all ${answers.length} answers?`) && onResetAnswers()}>Reset answers</button></>}
        </p>
        {answers.length > 0 && (
          <details className="profile-details">
            <summary>See what your answers have taught Forge</summary>
            <table className="profile-table">
              <thead><tr><th>Situation</th><th>You</th><th>Forge default</th><th>Answers</th></tr></thead>
              <tbody>
                {rates.map((r) => (
                  <tr key={r.key} className={r.answers ? '' : 'muted'}>
                    <td>{r.label}</td>
                    <td className="num"><strong>{pct(r.value, 0)}</strong></td>
                    <td className="num">{pct(r.forgeDefault, 0)}</td>
                    <td className="num">{r.answers}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="muted small">&quot;You&quot; blends your answers with Forge&apos;s default, weighted as if the default were 4 answers, so a few early answers can&apos;t swing it too far.</p>
          </details>
        )}
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>What would you do?</h2>
          <select value={deck?.id} onChange={(e) => setDeckId(e.target.value)} title="The deck you play in these situations" style={{ maxWidth: 360 }}>
            {decks.map((d) => <option key={d.id} value={d.id}>You play: {d.name}</option>)}
          </select>
        </div>

        {failed && <p className="warn">Couldn&apos;t build a situation with this deck right now — try another deck.</p>}
        {scenario && (
          <>
            <div className={`question ${flash ? 'saved' : ''}`}>
              <div className="small muted">Round {scenario.round}</div>
              <p className="situation">{scenario.situation}</p>
              <p className="ask"><strong>{scenario.question}</strong></p>
              <div className="answer-row">
                <button className="primary big" onClick={() => answer(true)}><kbd>1</kbd> {scenario.yesLabel}</button>
                <button className="big" onClick={() => answer(false)}><kbd>2</kbd> {scenario.noLabel}</button>
                <button className="link" onClick={next}>Skip (S)</button>
              </div>
            </div>
            <BoardView scenario={scenario} />
          </>
        )}
      </section>
    </>
  );
}
