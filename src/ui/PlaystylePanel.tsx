import { useEffect, useMemo, useState } from 'react';
import type { SimDeck } from '../engine/types';
import { agreement, describe, fitWeights, type Answer, type DecisionKind } from '../ai/playstyle';
import { makeScenario, type PermView, type PlayerView, type Scenario } from '../ai/scenario';
import { pct } from './format';

interface Props {
  decks: SimDeck[];
  selected: string[];
  answers: Answer[];
  onAnswer: (a: Answer) => void;
  onResetAnswers: () => void;
  usePlaystyle: boolean;
  onUsePlaystyle: (on: boolean) => void;
}

const KIND_LABEL: Record<DecisionKind, string> = { threat: 'Biggest threat', attack: 'Who to attack', cast: 'What to cast' };
const KINDS: DecisionKind[] = ['threat', 'attack', 'cast'];

export function PlaystylePanel({ decks, selected, answers, onAnswer, onResetAnswers, usePlaystyle, onUsePlaystyle }: Props) {
  const [deckId, setDeckId] = useState<string>(() => selected[0] ?? decks[0]?.id ?? '');
  const [kindMode, setKindMode] = useState<DecisionKind | 'mix'>('mix');
  const [scenario, setScenario] = useState<Scenario | null>(null);
  const [picked, setPicked] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);

  const deck = decks.find((d) => d.id === deckId) ?? decks[0];
  const weights = useMemo(() => fitWeights(answers), [answers]);
  const agree = useMemo(() => agreement(answers), [answers]);
  const traits = useMemo(() => describe(weights, answers), [weights, answers]);
  const counts = KINDS.map((k) => answers.filter((a) => a.kind === k).length);

  function next() {
    if (!deck) return;
    // In "mix" mode, ask about whatever you've answered least.
    const order = kindMode === 'mix' ? [...KINDS].sort((a, b) => counts[KINDS.indexOf(a)] - counts[KINDS.indexOf(b)] || Math.random() - 0.5) : [kindMode];
    for (const kind of order) {
      const s = makeScenario(decks, deck, kind);
      if (s) {
        setScenario(s);
        setPicked(null);
        setFailed(false);
        return;
      }
    }
    setScenario(null);
    setFailed(true);
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => next(), [deckId, kindMode]);

  function choose(option: number) {
    if (!scenario || picked !== null) return;
    setPicked(option);
    onAnswer({ kind: scenario.kind, options: scenario.options, chosen: option, aiChoice: scenario.aiChoice, at: Date.now() });
  }

  if (decks.length < 2) return <section className="panel empty"><p>Import at least two decks — the quiz needs opponents.</p></section>;

  return (
    <>
      <section className="panel">
        <div className="panel-head">
          <h2>Your playstyle</h2>
          <label className="toggle">
            <input type="checkbox" checked={usePlaystyle} onChange={(e) => onUsePlaystyle(e.target.checked)} disabled={!answers.length} />
            Pilot quick-engine games with my playstyle
          </label>
        </div>
        <p className="muted small">
          Answer questions about real game situations. Each answer teaches the simulator how you weigh threats, targets and plays; with the switch on, the quick engine
          plays every deck your way. With no answers it plays exactly like the default AI. (Forge games use Forge&apos;s own AI and aren&apos;t affected.)
        </p>
        <div className="kpis">
          {KINDS.map((k, i) => <div key={k} className="kpi"><span>{counts[i]}</span>{KIND_LABEL[k]} answers</div>)}
          <div className="kpi" title="How often each AI picks what you picked. Your style is scored on answers it wasn't trained on (leave-one-out).">
            <span>{agree ? `${pct(agree.defaultAi, 0)} → ${pct(agree.yourStyle, 0)}` : '—'}</span>
            agreement: default AI → your style
          </div>
        </div>
        {traits.length > 0 ? (
          <ul className="traits">{traits.map((t, i) => <li key={i}><span className="tag">{KIND_LABEL[t.kind]}</span> {t.text}</li>)}</ul>
        ) : (
          <p className="muted small">Answer a few questions of each type to see how your style differs from the AI.</p>
        )}
        {answers.length > 0 && (
          <button className="danger" onClick={() => confirm(`Forget all ${answers.length} answers?`) && onResetAnswers()}>Reset answers</button>
        )}
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>Quiz</h2>
          <div className="quiz-controls">
            <select value={deck?.id} onChange={(e) => setDeckId(e.target.value)} title="The deck you play in these scenarios">
              {decks.map((d) => <option key={d.id} value={d.id}>You play: {d.name}</option>)}
            </select>
            <div className="seg">
              <button className={kindMode === 'mix' ? 'active' : ''} onClick={() => setKindMode('mix')}>Mix</button>
              {KINDS.map((k) => <button key={k} className={kindMode === k ? 'active' : ''} onClick={() => setKindMode(k)}>{KIND_LABEL[k]}</button>)}
            </div>
          </div>
        </div>

        {failed && <p className="warn">Couldn&apos;t find a situation for that question with this deck — try another question type or deck.</p>}
        {scenario && (
          <>
            <div className="question">
              <strong>Round {scenario.round}.</strong> {scenario.prompt}
              {scenario.kind === 'attack' && <div className="small muted">Your attackers: {scenario.attackers.join(', ')}</div>}
              {scenario.kind === 'cast' && <div className="small muted">You have {scenario.mana} mana available.</div>}
            </div>

            {picked !== null && (
              <div className={`reveal ${picked === scenario.aiChoice ? 'same' : 'diff'}`}>
                You picked <strong>{scenario.optionLabels[picked]}</strong>.{' '}
                {picked === scenario.aiChoice
                  ? 'The default AI agrees.'
                  : <>The default AI would have picked <strong>{scenario.optionLabels[scenario.aiChoice]}</strong>.</>}
                <button className="primary" onClick={next}>Next situation →</button>
              </div>
            )}
            {picked === null && <button className="skip" onClick={next}>Skip this one</button>}

            <Board scenario={scenario} picked={picked} onChoose={choose} />
          </>
        )}
      </section>
    </>
  );
}

function Board({ scenario, picked, onChoose }: { scenario: Scenario; picked: number | null; onChoose: (i: number) => void }) {
  const you = scenario.players.find((p) => p.you)!;
  const opponents = scenario.players.filter((p) => !p.you);
  const state = (option: number | null) =>
    option === null ? '' : picked === null ? 'pickable' : option === picked ? 'picked' : option === scenario.aiChoice ? 'ai-pick' : '';

  return (
    <div className="board">
      <div className="opponents">
        {opponents.map((p) => <PlayerBox key={p.seat} p={p} state={state} onChoose={onChoose} kind={scenario.kind} />)}
      </div>
      <PlayerBox p={you} state={state} onChoose={onChoose} kind={scenario.kind} />
      <div className="hand">
        <div className="hand-title">Your hand</div>
        <div className="hand-cards">
          {scenario.hand.map((c, i) => (
            <button key={i} className={`hand-card ${state(c.option)}`} disabled={scenario.kind !== 'cast' || c.option === null || picked !== null} onClick={() => c.option !== null && onChoose(c.option)} title={c.detail}>
              <span className="hc-name">{c.name}</span>
              <span className="hc-cost">{c.cost}</span>
            </button>
          ))}
          {scenario.kind === 'cast' && scenario.passOption !== null && (
            <button className={`hand-card pass ${state(scenario.passOption)}`} disabled={picked !== null} onClick={() => onChoose(scenario.passOption!)}>
              <span className="hc-name">Hold up mana / cast nothing</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function PlayerBox({ p, state, onChoose, kind }: { p: PlayerView; state: (o: number | null) => string; onChoose: (i: number) => void; kind: DecisionKind }) {
  const pickPlayer = kind === 'attack' && p.option !== null;
  return (
    <div className={`player-box ${p.you ? 'you' : ''} ${pickPlayer ? state(p.option) : ''}`}>
      <div className="pb-head">
        <div>
          <strong>{p.you ? 'You' : p.deckName}</strong>
          <div className="muted small">{p.commander}</div>
        </div>
        <div className="pb-life">{p.life}</div>
      </div>
      <div className="pb-meta small muted">
        {p.lands} lands · {p.hand} cards in hand · {p.library} in library
        {p.attackedYouLastRound && <span className="tag warn-tag">attacked you last round</span>}
        {p.commanderDamage.length > 0 && <div>Commander damage taken: {p.commanderDamage.join(', ')}</div>}
      </div>
      {pickPlayer && (
        <button className="primary attack-btn" disabled={state(p.option) !== 'pickable'} onClick={() => onChoose(p.option!)}>Attack this player</button>
      )}
      <PermList perms={p.creatures} state={state} onChoose={onChoose} clickable={kind === 'threat'} />
      <PermList perms={p.others} state={state} onChoose={onChoose} clickable={kind === 'threat'} />
    </div>
  );
}

function PermList({ perms, state, onChoose, clickable }: { perms: PermView[]; state: (o: number | null) => string; onChoose: (i: number) => void; clickable: boolean }) {
  if (!perms.length) return null;
  return (
    <div className="perms">
      {perms.map((perm, i) => {
        const s = clickable ? state(perm.option) : '';
        return (
          <button key={i} className={`perm ${s} ${perm.tapped ? 'tapped' : ''}`} disabled={s !== 'pickable'} onClick={() => perm.option !== null && onChoose(perm.option)} title={perm.detail}>
            {perm.count > 1 && <span className="perm-count">{perm.count}×</span>}
            {perm.commander && <span className="tag">CMDR</span>}
            <span className="perm-name">{perm.name}</span>
            {perm.pt && <span className="perm-pt">{perm.pt}</span>}
            {perm.keywords.length > 0 && <span className="perm-kw">{perm.keywords.join(', ')}</span>}
            {perm.sick && <span className="perm-kw">summoning sick</span>}
          </button>
        );
      })}
    </div>
  );
}
