// Play a game of Commander yourself against Proliferate's bots.
//
// The rules engine (src/rules) asks for one decision at a time. This panel
// shows the table and turns clicks into answers: click a card to play it,
// click attackers and blockers, click a highlighted target.

import { useEffect, useReducer, useRef, useState } from 'react';
import type { Effect, SimCard, SimDeck } from '../engine/types';
import { describeProtection } from '../engine/classifyCombat';
import { threat } from '../rules/bot';
import { spreeLabel, type Game } from '../rules/game';
import { Session } from '../rules/session';
import { STEP_NAMES, type Action, type Decision, type Perm, type PlayerState, type Target } from '../rules/types';
import { CardFace, cardImage, usePreview } from './BoardView';
import { commanderNames } from './format';
import { cardKey, loadFxLevel, saveFxLevel, useTableFx, type FxLevel } from './tableFx';

type Bind = (url: string | null) => object;
type Speed = 'instant' | 'fast' | 'slow';
const DELAY: Record<Speed, number> = { instant: 0, fast: 300, slow: 900 };
/** The longest the bots wait for an animation to finish before their next play. */
const MAX_HOLD: Record<Speed, number> = { instant: 0, fast: 900, slow: 1600 };
const ME = 0;

interface Setup {
  deckId: string;
  /** Deck id per bot, or '' for a random deck. */
  opponents: string[];
}

// The game in progress survives switching tabs (but not reloading the page).
let current: { session: Session; setup: Setup } | null = null;

export function PlayPanel({ decks }: { decks: SimDeck[] }) {
  const [, redraw] = useReducer((x: number) => x + 1, 0);
  const [setup, setSetup] = useState<Setup>(() => current?.setup ?? { deckId: decks[0]?.id ?? '', opponents: ['', '', ''] });
  const [speed, setSpeed] = useState<Speed>('fast');
  const [fx, setFx] = useState<FxLevel>(loadFxLevel);
  const session = current?.session ?? null;
  /** When (performance.now) the animations on screen finish. */
  const fxUntil = useRef(0);
  const lastStep = useRef(0);

  // Let the bots play, one logged event at a time so the game can be followed.
  // Each play waits for the animations of the last one, up to a limit.
  useEffect(() => {
    if (!session || !session.busy) return;
    if (speed === 'instant') {
      session.run();
      redraw();
      return;
    }
    const now = performance.now();
    const hold = Math.min(MAX_HOLD[speed], Math.max(0, fxUntil.current - lastStep.current));
    const wait = Math.max(0, lastStep.current + Math.max(DELAY[speed], hold) - now);
    const timer = setTimeout(() => {
      lastStep.current = performance.now();
      session.step();
      redraw();
    }, wait);
    return () => clearTimeout(timer);
  });

  if (!decks.length) {
    return <section className="panel empty">Import a deck on the Decks tab first, then come back to play it against bots.</section>;
  }

  const start = (s: Setup) => {
    const mine = decks.find((d) => d.id === s.deckId) ?? decks[0];
    const others = decks.filter((d) => d.id !== mine.id);
    const pool = others.length ? others : decks;
    const seats = [mine, ...s.opponents.map((id) => decks.find((d) => d.id === id) ?? pool[Math.floor(Math.random() * pool.length)])];
    const names = seats.map((d, i) => (i === ME ? 'You (P1)' : `${d.name} (P${i + 1})`));
    const seed = (Math.random() * 2 ** 32) >>> 0;
    current = { session: new Session(seats, seed, ME, { names, maxRounds: 200, startSeat: Math.floor(Math.random() * seats.length) }), setup: s };
    redraw();
  };

  if (!session) return <SetupForm decks={decks} setup={setup} onSetup={setSetup} onStart={() => start(setup)} />;

  return (
    <Table
      session={session}
      speed={speed}
      onSpeed={setSpeed}
      fx={fx}
      onFx={(level) => {
        saveFxLevel(level);
        setFx(level);
      }}
      fxUntil={fxUntil}
      redraw={redraw}
      onRestart={() => start(current!.setup)}
      onQuit={() => {
        current = null;
        redraw();
      }}
    />
  );
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

function SetupForm({ decks, setup, onSetup, onStart }: { decks: SimDeck[]; setup: Setup; onSetup: (s: Setup) => void; onStart: () => void }) {
  const setOpponents = (n: number) => onSetup({ ...setup, opponents: Array.from({ length: n }, (_, i) => setup.opponents[i] ?? '') });
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Play against bots</h2>
      </div>
      <p className="muted small">
        Pilot one of your decks at a table of Proliferate&apos;s own bots. The game follows the real turn structure, with priority, the stack, attackers and
        blockers, and the Commander rules. Cards whose text the engine can&apos;t interpret yet are marked <span className="nofx-inline">no effect</span> and
        play as plain permanents.
      </p>
      <div className="control-row">
        <label>
          <span>Your deck</span>
          <select value={setup.deckId} onChange={(e) => onSetup({ ...setup, deckId: e.target.value })}>
            {decks.map((d) => <option key={d.id} value={d.id}>{d.name} — {commanderNames(d)}</option>)}
          </select>
        </label>
        <label>
          <span>Opponents</span>
          <select value={setup.opponents.length} onChange={(e) => setOpponents(+e.target.value)}>
            {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n} bot{n > 1 ? 's' : ''}{n === 3 ? ' (standard table)' : ''}</option>)}
          </select>
        </label>
      </div>
      <div className="control-row" style={{ marginTop: 12 }}>
        {setup.opponents.map((id, i) => (
          <label key={i}>
            <span>Bot {i + 1} plays</span>
            <select value={id} onChange={(e) => onSetup({ ...setup, opponents: setup.opponents.map((x, j) => (j === i ? e.target.value : x)) })}>
              <option value="">A random deck</option>
              {decks.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </label>
        ))}
      </div>
      <div className="cta" style={{ marginTop: 18 }}>
        <button className="primary big" onClick={onStart}>Deal me in →</button>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

interface TableProps {
  session: Session;
  speed: Speed;
  onSpeed: (s: Speed) => void;
  fx: FxLevel;
  onFx: (level: FxLevel) => void;
  fxUntil: React.RefObject<number>;
  redraw: () => void;
  onRestart: () => void;
  onQuit: () => void;
}

function Table({ session, speed, onSpeed, fx, onFx, fxUntil, redraw, onRestart, onQuit }: TableProps) {
  const g = session.game;
  const d = session.pending;
  const me = g.players[ME];
  const { bind, view } = usePreview();

  // Animations: compare the table with the last render that changed the game.
  const tableRef = useRef<HTMLDivElement>(null);
  const signature = `${g.log!.length}|${g.stack.length}|${g.step}|${g.activeSeat}|${d ? 'd' : ''}|${session.result ? 'r' : ''}`;
  useTableFx(tableRef, g, signature, { level: fx, me: ME, names: g.players.map((p) => (p.seat === ME ? 'You' : shortName(p))) }, fxUntil);

  // Selections in progress for the current decision.
  const [attacks, setAttacks] = useState<Map<number, number>>(new Map());
  const [defender, setDefender] = useState<number | null>(null);
  const [blocks, setBlocks] = useState<Map<number, number>>(new Map());
  const [picked, setPicked] = useState<number | null>(null);
  const [chosen, setChosen] = useState<number[]>([]);
  const [menu, setMenu] = useState<number[] | null>(null);
  const [x, setX] = useState(0);
  const [filter, setFilter] = useState('');
  useEffect(() => {
    setAttacks(new Map());
    setBlocks(new Map());
    setPicked(null);
    setChosen([]);
    setMenu(null);
    setFilter('');
    setDefender(d?.kind === 'attackers' ? d.defenders[0] : null);
  }, [d]);

  const logRef = useRef<HTMLOListElement>(null);
  const logLength = g.log!.length;
  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [logLength]);

  const answer = (a: Parameters<Session['answer']>[0]) => {
    session.answer(a);
    redraw();
  };

  // ----- What can be clicked for the current decision ----------------------
  const actions = d?.kind === 'priority' ? d.actions : [];
  const indexesFor = (match: (a: Action) => boolean) => actions.flatMap((a, i) => (match(a) ? [i] : []));
  const choose = (indexes: number[]) => {
    if (!indexes.length) return;
    const only = actions[indexes[0]];
    if (indexes.length === 1 && only.type !== 'cycle' && !(only.type === 'cast' && only.maxX > 0)) answer({ action: indexes[0] });
    else {
      setMenu(indexes);
      setX(only.type === 'cast' ? only.maxX : 0);
    }
  };
  const targets = d?.kind === 'target' ? d.candidates : [];
  const isTarget = (t: Target) => targets.some((c) => c.kind === t.kind && (c.kind === 'player' ? c.seat === (t as { seat: number }).seat : c.id === (t as { id: number }).id));

  const permState = (perm: Perm): { cls: string; onClick?: () => void } => {
    if (!d) return { cls: '' };
    if (d.kind === 'priority') {
      const mine = indexesFor((a) => (a.type === 'activate' || a.type === 'crew' || a.type === 'station' || a.type === 'turnFaceUp' || a.type === 'level' || a.type === 'unlock') && a.permId === perm.id);
      return mine.length ? { cls: 'can', onClick: () => choose(mine) } : { cls: '' };
    }
    if (d.kind === 'target' && isTarget({ kind: 'perm', id: perm.id })) return { cls: 'target', onClick: () => answer({ kind: 'perm', id: perm.id }) };
    if (d.kind === 'attackers' && d.candidates.includes(perm.id)) {
      const on = attacks.has(perm.id);
      return {
        cls: on ? 'selected' : 'can',
        onClick: () => {
          const next = new Map(attacks);
          if (on) next.delete(perm.id);
          else next.set(perm.id, defender ?? d.defenders[0]);
          setAttacks(next);
        },
      };
    }
    if (d.kind === 'blockers') {
      if (d.candidates.includes(perm.id)) {
        const on = blocks.has(perm.id);
        return {
          cls: picked === perm.id ? 'selected' : on ? 'selected' : 'can',
          onClick: () => {
            if (on) {
              const next = new Map(blocks);
              next.delete(perm.id);
              setBlocks(next);
              setPicked(null);
            } else setPicked(picked === perm.id ? null : perm.id);
          },
        };
      }
      const blocker = g.findPerm(picked);
      if (d.attackers.includes(perm.id) && blocker && g.canBlock(blocker, perm)) {
        return {
          cls: 'target',
          onClick: () => {
            setBlocks(new Map(blocks).set(blocker.id, perm.id));
            setPicked(null);
          },
        };
      }
    }
    return { cls: '' };
  };

  const cardState = (card: SimCard, from: 'hand' | 'command'): { cls: string; onClick?: () => void } => {
    if (d?.kind !== 'priority') return { cls: '' };
    const mine = indexesFor((a) => (a.type === 'cast' && a.card === card && (a.from === from || ((a.from === 'overload' || a.from === 'alt') && from === 'hand'))) || (a.type === 'land' && a.card === card && from === 'hand') || (a.type === 'cycle' && a.card === card && from === 'hand'));
    return mine.length ? { cls: 'can', onClick: () => choose(mine) } : { cls: '' };
  };

  const badge = (perm: Perm): string | null => {
    if (attacks.has(perm.id)) return `⚔ ${attackTarget(g, attacks.get(perm.id)!).label}`;
    if (blocks.has(perm.id)) return `🛡 ${g.findPerm(blocks.get(perm.id)!)?.card.name ?? ''}`;
    if (perm.attacking !== null) return `⚔ ${perm.attackingPw !== undefined ? g.findPerm(perm.attackingPw)?.card.name ?? 'planeswalker' : shortName(g.players[perm.attacking])}${perm.blocked ? ' (blocked)' : ''}`;
    if (perm.blocking !== null) return `🛡 ${g.findPerm(perm.blocking)?.card.name ?? ''}`;
    return null;
  };

  const opponents = g.players.filter((p) => p.seat !== ME);
  const active = g.players[g.activeSeat];

  return (
    <div className={`play fx-${fx}`} ref={tableRef}>
      {view}
      <section className="panel play-bar">
        <div className="play-bar-turn">
          <strong>Round {Math.max(1, g.round)}</strong>
          <span className="muted"> · {active.seat === ME ? 'Your turn' : `${shortName(active)}'s turn`}</span>
          <PhaseTrack step={g.step} mine={active.seat === ME} />
        </div>
        <div className="play-bar-controls">
          <label className="small muted" title="Card motion and effects. Quick keeps them short; Off shows each change at once.">
            Animations{' '}
            <select value={fx} onChange={(e) => onFx(e.target.value as FxLevel)}>
              <option value="full">Full</option>
              <option value="quick">Quick</option>
              <option value="off">Off</option>
            </select>
          </label>
          <label className="small muted" title="How quickly the bots' plays are shown.">
            Bot speed{' '}
            <select value={speed} onChange={(e) => onSpeed(e.target.value as Speed)}>
              <option value="slow">Slow</option>
              <option value="fast">Fast</option>
              <option value="instant">Instant</option>
            </select>
          </label>
          <label className="small muted" title="Stop every time you could do something, even when you'd rarely want to. Off: you are asked in your main phases, when an opponent's spell or ability is on the stack, in combat that involves you, and at the end of the turn before yours.">
            <input type="checkbox" checked={session.fullControl} onChange={(e) => { session.fullControl = e.target.checked; redraw(); }} /> Full control
          </label>
          <button onClick={onRestart}>Restart</button>
          <button onClick={onQuit}>Change decks</button>
        </div>
      </section>

      <div className="play-grid">
        <div className="play-main">
          <div className="mats">
            {opponents.map((p) => (
              <Mat key={p.seat} g={g} p={p} me={false} bind={bind} permState={permState} badge={badge} cardState={cardState}
                target={d?.kind === 'target' && isTarget({ kind: 'player', seat: p.seat }) ? () => answer({ kind: 'player', seat: p.seat }) : undefined} />
            ))}
          </div>

          {g.stack.length > 0 && (
            <section className="panel stack-panel">
              <strong>The stack</strong> <span className="muted small">(top resolves first)</span>
              <ol className="stack-list">
                {[...g.stack].reverse().map((item) => {
                  const hit = d?.kind === 'target' && isTarget({ kind: 'stack', id: item.id });
                  const aimed = [item.attachTo, ...item.targets].filter((t): t is Target => !!t);
                  return (
                    <li key={item.id} className={`${hit ? 'target' : ''} ${item.kind}`} onClick={hit ? () => answer({ kind: 'stack', id: item.id }) : undefined} {...bind(item.card.imageUrl ?? cardImage(item.card.name))}
                      data-fx={`stack:${item.id}`} data-fx-card={cardKey(item.card)} data-fx-name={item.card.name} data-fx-img={item.card.imageUrl ?? ''}>
                      <span className="stack-thumb"><CardFace name={item.card.name} imageUrl={item.card.imageUrl ?? null} pt={null} /></span>
                      <strong>{item.label}</strong>
                      <span className="muted"> — {shortName(g.players[item.controller])}{aimed.length ? ` → ${aimed.map((t) => g.describeTarget(t)).join(', ')}` : ''}</span>
                    </li>
                  );
                })}
              </ol>
            </section>
          )}

          <section className={`panel prompt ${d ? 'waiting' : ''}`}>
            {session.result ? (
              <GameOver g={g} onRestart={onRestart} onQuit={onQuit} />
            ) : !d ? (
              <span className="muted">The bots are playing…</span>
            ) : (
              <Prompt
                g={g} d={d} menu={menu} x={x} setX={setX} setMenu={setMenu} answer={answer} bind={bind}
                attacks={attacks} setAttacks={setAttacks} defender={defender} setDefender={setDefender}
                blocks={blocks} picked={picked} chosen={chosen} setChosen={setChosen} filter={filter} setFilter={setFilter}
              />
            )}
          </section>

          <Mat g={g} p={me} me bind={bind} permState={permState} badge={badge} cardState={cardState}
            target={d?.kind === 'target' && isTarget({ kind: 'player', seat: ME }) ? () => answer({ kind: 'player', seat: ME }) : undefined} />

          <div className="hand-mat">
            <div className="mat-head">
              <strong>Your hand</strong>
              <span className="muted small">{g.availableMana(me)} mana available{me.treasures ? ` (${me.treasures} Treasure)` : ''}</span>
            </div>
            <div className="card-row">
              {me.hand.length === 0 && <span className="muted small">No cards in hand</span>}
              {handKeys(me.hand).map(({ card, key }) => {
                const s = cardState(card, 'hand');
                return <HandCard key={key} fxKey={key} card={card} cls={s.cls} onClick={s.onClick} bind={bind} />;
              })}
            </div>
          </div>
        </div>

        <aside className="panel play-log">
          <strong>Game log</strong>
          <ol className="gamelog" ref={logRef}>
            {g.log!.slice(-400).map((line, i) => (
              <li key={i} className={line.startsWith('—') ? 'round' : /eliminated|wins on/.test(line) ? 'big' : ''}>{line}</li>
            ))}
          </ol>
        </aside>
      </div>
    </div>
  );
}

/** The turn's steps as a row of pips, the current one lit. */
const PHASES: { label: string; steps: string[] }[] = [
  { label: 'Beginning', steps: ['untap', 'upkeep', 'draw'] },
  { label: 'Main', steps: ['main1'] },
  { label: 'Combat', steps: ['beginCombat', 'declareAttackers', 'declareBlockers', 'combatDamage', 'endCombat'] },
  { label: 'Main 2', steps: ['main2'] },
  { label: 'End', steps: ['end', 'cleanup'] },
];

function PhaseTrack({ step, mine }: { step: string; mine: boolean }) {
  return (
    <div className={`phase-track ${mine ? 'mine' : ''}`} title={STEP_NAMES[step as keyof typeof STEP_NAMES]}>
      {PHASES.map((ph) => {
        const at = ph.steps.indexOf(step);
        return (
          <span key={ph.label} className={`phase ${at >= 0 ? 'on' : ''}`}>
            {ph.label}
            {ph.steps.length > 1 && (
              <span className="phase-dots">{ph.steps.map((s, i) => <i key={s} className={i === at ? 'on' : i < at ? 'past' : ''} />)}</span>
            )}
          </span>
        );
      })}
      <span className="phase-step">{STEP_NAMES[step as keyof typeof STEP_NAMES]}</span>
    </div>
  );
}

function shortName(p: PlayerState): string {
  return p.name.replace(/ \(P\d\)$/, '');
}

// ---------------------------------------------------------------------------
// Prompt: what the game is asking, and the buttons to answer it
// ---------------------------------------------------------------------------

interface PromptProps {
  g: Game;
  d: Decision;
  menu: number[] | null;
  x: number;
  setX: (n: number) => void;
  setMenu: (m: number[] | null) => void;
  answer: (a: Parameters<Session['answer']>[0]) => void;
  bind: Bind;
  attacks: Map<number, number>;
  setAttacks: (m: Map<number, number>) => void;
  defender: number | null;
  setDefender: (n: number) => void;
  blocks: Map<number, number>;
  picked: number | null;
  chosen: number[];
  setChosen: (c: number[]) => void;
  filter: string;
  setFilter: (s: string) => void;
}

function Prompt({ g, d, menu, x, setX, setMenu, answer, bind, attacks, setAttacks, defender, setDefender, blocks, picked, chosen, setChosen, filter, setFilter }: PromptProps) {
  switch (d.kind) {
    case 'priority': {
      if (menu) {
        return (
          <div className="prompt-row">
            <span>Choose:</span>
            {menu.map((i) => {
              const a = d.actions[i];
              const hasX = a.type === 'cast' && a.maxX > 0;
              return (
                <span key={i} className="prompt-row">
                  {hasX && (
                    <label className="small">X = <input type="number" min={0} max={(a as { maxX: number }).maxX} value={x} onChange={(e) => setX(Math.max(0, Math.min((a as { maxX: number }).maxX, +e.target.value || 0)))} style={{ width: 60 }} /></label>
                  )}
                  <button className="primary" onClick={() => answer({ action: i, x: hasX ? x : 0 })}>{actionLabel(g, a)}</button>
                </span>
              );
            })}
            <button onClick={() => setMenu(null)}>Cancel</button>
          </div>
        );
      }
      const top = g.stack[g.stack.length - 1];
      const mine = g.activeSeat === ME;
      const pass = top
        ? top.controller === ME ? 'Let it resolve' : `Let ${top.label} resolve`
        : mine && g.step === 'main1' ? 'Go to combat' : mine && g.step === 'main2' ? 'End turn' : 'Continue';
      return (
        <div className="prompt-row">
          <span>
            {top && top.controller !== ME
              ? <><strong>{shortName(g.players[top.controller])}</strong> has <strong>{top.label}</strong> on the stack. Respond by clicking a highlighted card, or let it resolve.</>
              : mine
                ? <>Your <strong>{STEP_NAMES[g.step].toLowerCase()}</strong>. Click a highlighted card to play it.</>
                : <>{shortName(g.players[g.activeSeat])}&apos;s <strong>{STEP_NAMES[g.step].toLowerCase()}</strong>. You can act now, or continue.</>}
          </span>
          {d.actions.map((a, i) => ((a.type === 'cast' && a.from === 'graveyard') || a.type === 'graveyard' || (a.type === 'land' && a.fromGraveyard)
            ? <button key={i} onClick={() => (a.type === 'cast' && a.maxX > 0 ? setMenu([i]) : answer({ action: i }))}>{actionLabel(g, a)}</button>
            : null))}
          <button className="primary" onClick={() => answer({ action: 0 })}>{pass}</button>
        </div>
      );
    }
    case 'target':
      return (
        <div className="prompt-row">
          <span><strong>{d.prompt}</strong> Click a highlighted target.</span>
          {d.cancellable && <button onClick={() => answer(null)}>Cancel</button>}
        </div>
      );
    case 'attackers': {
      const list = [...attacks].map(([attacker, to]) => {
        const t = attackTarget(g, to);
        return { attacker, defender: t.defender, ...(t.planeswalker !== undefined ? { planeswalker: t.planeswalker } : {}) };
      });
      // Players, then planeswalkers and battles (chosen as -(id + 1)).
      const choices = [...d.defenders, ...(d.planeswalkers ?? []).map((id) => -(id + 1))];
      return (
        <div className="prompt-row">
          <span>
            <strong>Declare attackers.</strong> Click your creatures to attack with them.
            {d.goaded?.length ? ` Goaded (must attack, and not the player who goaded them): ${d.goaded.map((x) => g.findPerm(x.attacker)?.card.name).join(', ')}.` : ''}
          </span>
          {choices.length > 1 && (
            <label className="small">
              Attacking{' '}
              <select value={defender ?? d.defenders[0]} onChange={(e) => setDefender(+e.target.value)}>
                {choices.map((v) => <option key={v} value={v}>{attackTarget(g, v).label}{v >= 0 ? ` (${g.players[v].life} life)` : ''}</option>)}
              </select>
            </label>
          )}
          <button onClick={() => setAttacks(new Map(d.candidates.map((id) => [id, defender ?? d.defenders[0]])))}>All attack</button>
          <button className="primary" onClick={() => answer(list)}>{list.length ? `Attack with ${list.length}` : 'No attack'}</button>
        </div>
      );
    }
    case 'blockers': {
      const list = [...blocks].map(([blocker, attacker]) => ({ blocker, attacker }));
      const incoming = d.attackers.map((id) => g.findPerm(id)).filter((a): a is Perm => !!a);
      const unblocked = incoming.filter((a) => ![...blocks.values()].includes(a.id)).reduce((s, a) => s + g.power(a) * (g.hasKw(a, 'double strike') ? 2 : 1), 0);
      return (
        <div className="prompt-row">
          <span>
            <strong>Declare blockers.</strong>{' '}
            {picked !== null ? 'Now click the attacker it should block.' : 'Click one of your creatures, then the attacker it blocks.'}{' '}
            <span className="muted">{unblocked} damage is unblocked.</span>
          </span>
          <button className="primary" onClick={() => answer(list)}>{list.length ? `Block with ${list.length}` : 'No blocks'}</button>
        </div>
      );
    }
    case 'confirm':
      if (d.reason === 'mulligan') {
        return (
          <div className="prompt-row">
            <span><strong>{d.prompt}</strong> <span className="muted">The first mulligan is free; after that you put one card on the bottom for each.</span></span>
            <button className="primary" onClick={() => answer(false)}>Keep</button>
            <button onClick={() => answer(true)}>Mulligan</button>
          </div>
        );
      }
      if (d.reason !== 'commandZone') {
        return (
          <div className="prompt-row">
            <span><strong>{d.prompt}</strong></span>
            <button className="primary" onClick={() => answer(true)}>Yes</button>
            <button onClick={() => answer(false)}>No</button>
          </div>
        );
      }
      return (
        <div className="prompt-row">
          <span><strong>{d.prompt}</strong></span>
          <button className="primary" onClick={() => answer(true)}>Command zone</button>
          <button onClick={() => answer(false)}>Leave it</button>
        </div>
      );
    case 'choose': {
      const toggle = (i: number) => {
        if (chosen.includes(i)) setChosen(chosen.filter((c) => c !== i));
        else if (d.max === 1) setChosen([i]);
        else if (chosen.length < d.max) setChosen([...chosen, i]);
      };
      const shown = d.options.map((o, i) => ({ o, i })).filter(({ o }) => o.label.toLowerCase().includes(filter.toLowerCase()));
      const ready = chosen.length >= d.min && chosen.length <= d.max;
      return (
        <div>
          <div className="prompt-row">
            <span><strong>{d.prompt}</strong> <span className="muted">{chosen.length} chosen{d.min === d.max ? ` of ${d.min}` : ` (up to ${d.max})`}</span></span>
            {d.options.length > 12 && <input placeholder="Filter by name" value={filter} onChange={(e) => setFilter(e.target.value)} />}
            <button className="primary" disabled={!ready} onClick={() => answer(chosen)}>Confirm</button>
          </div>
          <div className="card-row choice-row">
            {shown.map(({ o, i }) => (
              <div key={i} className={`board-card ${chosen.includes(i) ? 'selected' : 'can'}`} onClick={() => toggle(i)} title={o.label}>
                <CardFace name={o.label} imageUrl={o.card ? o.card.imageUrl ?? cardImage(o.card.name) : null} pt={null} token {...bind(o.card ? o.card.imageUrl ?? cardImage(o.card.name) : null)} />
              </div>
            ))}
          </div>
        </div>
      );
    }
  }
}

function GameOver({ g, onRestart, onQuit }: { g: Game; onRestart: () => void; onQuit: () => void }) {
  const won = g.winner === ME;
  const place = g.placements[ME];
  return (
    <div className="prompt-row">
      <span>
        <strong>{won ? 'You win!' : g.winner === null ? 'The game is a draw.' : `${shortName(g.players[g.winner])} wins.`}</strong>{' '}
        <span className="muted">{won ? `In ${g.round} rounds.` : `You finished ${ordinal(place)} of ${g.players.length}.`}</span>
      </span>
      <button className="primary" onClick={onRestart}>Play again</button>
      <button onClick={onQuit}>Change decks</button>
    </div>
  );
}

/** What an attack choice in the attackers prompt means: a player's seat, or a planeswalker or battle stored as -(id + 1). */
function attackTarget(g: Game, v: number): { defender: number; planeswalker?: number; label: string } {
  if (v >= 0) return { defender: v, label: shortName(g.players[v]) };
  const pw = g.findPerm(-v - 1);
  if (!pw) return { defender: 0, label: 'planeswalker' };
  // A battle is defended by its protector (rule 506.2).
  if (pw.card.isBattle) {
    const by = pw.protector ?? pw.seat;
    return { defender: by, planeswalker: pw.id, label: `${pw.card.name} (battle, ${pw.defense ?? 0} defense, protected by ${shortName(g.players[by])})` };
  }
  return { defender: pw.seat, planeswalker: pw.id, label: `${pw.card.name} (${pw.loyalty ?? 0} loyalty, ${shortName(g.players[pw.seat])})` };
}

function ordinal(n: number): string {
  const r = Math.round(n);
  return `${r}${r === 1 ? 'st' : r === 2 ? 'nd' : r === 3 ? 'rd' : 'th'}`;
}

function altLabel(card: SimCard): string {
  const a = card.altCost!;
  const how = [
    a.pitch && `exile a ${({ W: 'white', U: 'blue', B: 'black', R: 'red', G: 'green' } as const)[a.pitch]} card`,
    a.life && `pay ${a.life} life`,
    a.returnIslands && `return ${a.returnIslands === 1 ? 'an Island' : `${a.returnIslands} Islands`}`,
    (a.mana.generic || a.mana.pips.length) && costText({ cost: a.mana } as SimCard),
  ].filter(Boolean).join(', ');
  const verb = a.evoke ? 'Evoke' : a.dash ? 'Dash' : a.blitz ? 'Blitz' : a.warp ? 'Warp' : a.impending ? `Impending (${a.impending} time counters)` : a.prowl ? 'Prowl' : a.emerge ? `Emerge (sacrifice ${a.emerge === 'artifact' ? 'an artifact' : 'a creature'}, minus its mana value)` : 'Cast';
  return `${verb} ${card.name} (${how || 'free'})`;
}

function costText(card: SimCard): string {
  const c = card.cost;
  const pips = c.pips.map((p) => `{${p.join('/')}}`).join('');
  return `${'{X}'.repeat(c.x)}${c.generic || (!pips && !c.x) ? `{${c.generic}}` : ''}${pips}`;
}

function effectLabel(e: Effect): string {
  switch (e.kind) {
    case 'draw': return 'draw';
    case 'removal': return e.mode === 'damage' ? 'deal damage' : e.mode;
    case 'tokens': return 'make tokens';
    case 'counters': return 'add +1/+1 counters';
    case 'ramp': return 'search for a land';
    case 'treasure': return 'make Treasure';
    case 'drain': return 'drain opponents';
    case 'damagePlayer': return 'damage a player';
    case 'gainLife': return 'gain life';
    case 'recursion': return 'return a creature';
    case 'tutor': return 'search your library';
    case 'pump': return 'pump a creature';
    case 'goad': return 'goad a creature';
    case 'blink': return 'exile and return';
    case 'untap': return 'untap';
    case 'copySpell': return 'copy';
    case 'hours': return 'add an hour counter';
    case 'extraCombat': return 'take an additional combat';
    case 'extraTurn': return 'take an extra turn';
    case 'artifactToken': return `make ${e.token === 'incubator' ? 'an Incubator' : `a ${e.token === 'food' ? 'Food' : 'Blood'}`}`;
    case 'hatch': return 'transform an Incubator';
    case 'emblem': return 'get an emblem';
    default: return e.kind;
  }
}

function actionLabel(g: Game, a: Action): string {
  switch (a.type) {
    case 'pass': return 'Pass';
    case 'land': return a.back ? `Play as a land (${a.card.backLand!.name})` : `Play ${a.card.name}${a.fromGraveyard ? ' from your graveyard' : ''}`;
    case 'cast': {
      if (a.faceDown) return `Cast ${a.card.name} face down {3}`;
      if (a.mutate) return `Mutate ${a.card.name} ${costText({ cost: a.card.mutate!.cost } as SimCard)}${a.from === 'graveyard' ? ' from your graveyard' : ''}`;
      if (a.from === 'overload') return `Overload ${a.card.name} ${costText({ cost: a.card.overload!.cost } as SimCard)}`;
      if (a.from === 'alt') return altLabel(a.card);
      if (a.door && a.card.room) return `Cast ${a.card.room.door.name} ${costText(a.card.room.door)}`;
      if (a.modes) return `Cast ${a.card.name} (${spreeLabel(a.card, a.modes)}) ${costText(g.spreeCard(a.card, a.modes))}`;
      if (a.from === 'foretell') return `Cast foretold ${a.card.name} ${costText(g.castCard(a.card, 'foretell'))}`;
      if (a.from === 'plot') return `Cast plotted ${a.card.name} (free)`;
      if (a.from === 'warp') return `Cast warped ${a.card.name} ${costText(a.card)}`;
      if (a.from === 'madness' || a.from === 'miracle') return `Cast ${a.card.name} for its ${a.from} cost ${costText(g.castCard(a.card, a.from))}`;
      if (a.kick) {
        const k = a.card.kicker!;
        const how = k.offspring ? 'with offspring' : k.as === 'replicate' ? `replicated ${a.kick}×` : k.as ? { entwine: 'entwined', buyback: 'with buyback', bargain: 'bargained', gift: 'promising the gift', cleave: 'with cleave', casualty: 'with casualty', replicate: '' }[k.as] : k.multi ? `kicked ${a.kick}×` : 'kicked';
        return `Cast ${a.card.name} ${how} ${costText(g.kickedCard(a.card, a.kick))}`;
      }
      if (a.from !== 'graveyard') return `Cast ${a.card.name} ${costText(a.card)}`;
      const how = a.card.flashback ? 'Flashback' : a.card.graveyard?.how === 'cast' ? a.card.graveyard.label[0].toUpperCase() + a.card.graveyard.label.slice(1) : 'Cast from graveyard:';
      return `${how} ${a.card.name} ${costText(g.castCard(a.card, 'graveyard'))}`;
    }
    case 'graveyard': {
      const use = a.card.graveyard!;
      const what = use.label === 'return' ? `Return ${a.card.name} from your graveyard` : `${use.label[0].toUpperCase()}${use.label.slice(1)} ${a.card.name}`;
      return `${what} ${costText({ cost: use.cost } as SimCard)}`;
    }
    case 'level': {
      const perm = g.findPerm(a.permId);
      const next = perm ? g.nextLevel(perm) : undefined;
      return `${perm?.card.name ?? 'Class'}: level ${next?.level ?? ''} ${next ? costText({ cost: next.cost } as SimCard) : ''}`;
    }
    case 'unlock': {
      const door = g.findPerm(a.permId)?.card.room?.door;
      return `Unlock ${door?.name ?? 'door'} ${door ? costText(door) : ''}`;
    }
    case 'crew': return `Crew ${g.findPerm(a.permId)?.card.name ?? 'Vehicle'}`;
    case 'station': return `Station ${g.findPerm(a.permId)?.card.name ?? 'Spacecraft'}`;
    case 'ninjutsu': return `Ninjutsu ${a.card.name} ${costText({ cost: a.card.ninjutsu!.cost } as SimCard)} for ${g.findPerm(a.permId)?.card.name ?? 'an attacker'}`;
    case 'turnFaceUp': {
      const perm = g.findPerm(a.permId);
      return `Turn face up: ${perm?.faceDown?.name ?? 'creature'} ${costText({ cost: (perm && g.faceUpCost(perm)) ?? { generic: 0, pips: [], x: 0, life: 0 } } as SimCard)}`;
    }
    case 'cycle': return `Cycle ${a.card.name} ${costText({ cost: a.card.cycling!.cost } as SimCard)}`;
    case 'hand': {
      const c = a.card.casting!;
      switch (a.how) {
        case 'foretell': return `Foretell ${a.card.name} {2}`;
        case 'plot': return `Plot ${a.card.name} ${costText({ cost: c.plot! } as SimCard)}`;
        case 'suspend': return `Suspend ${a.card.name} ${costText({ cost: c.suspend!.cost } as SimCard)} (${c.suspend!.n} turns)`;
        case 'transmute': return `Transmute ${a.card.name} ${costText({ cost: c.transmute! } as SimCard)}`;
        case 'channel': return `Channel ${a.card.name} ${costText({ cost: c.channel!.cost } as SimCard)}`;
      }
      return a.card.name;
    }
    case 'activate': {
      const name = g.findPerm(a.permId)?.card.name ?? 'ability';
      return a.effect.kind === 'equip' ? `Equip ${name} ${costText({ cost: a.effect.cost ?? { generic: 2, pips: [], x: 0, life: 0 } } as SimCard)}` : `${name}: ${effectLabel(a.effect)}`;
    }
  }
}

// ---------------------------------------------------------------------------
// A player's side of the table
// ---------------------------------------------------------------------------

interface MatProps {
  g: Game;
  p: PlayerState;
  me: boolean;
  bind: Bind;
  permState: (perm: Perm) => { cls: string; onClick?: () => void };
  cardState: (card: SimCard, from: 'hand' | 'command') => { cls: string; onClick?: () => void };
  badge: (perm: Perm) => string | null;
  target?: () => void;
}

function Mat({ g, p, me, bind, permState, cardState, badge, target }: MatProps) {
  const lands = p.battlefield.filter((q) => q.landInfo);
  const creatures = p.battlefield.filter((q) => !q.landInfo && q.card.isCreature);
  const others = p.battlefield.filter((q) => !q.landInfo && !q.card.isCreature);
  const landGroups = new Map<string, { name: string; tapped: boolean; n: number; card: SimCard }>();
  for (const l of lands) {
    const name = l.landInfo === l.card.backLand ? l.card.backLand!.name : l.card.name;
    const key = `${name}|${l.tapped}`;
    landGroups.set(key, { name, tapped: l.tapped, n: (landGroups.get(key)?.n ?? 0) + 1, card: l.card });
  }
  // Commander damage is counted per commander (rule 903.10a): name the commander when a player has two.
  const damage = [...p.commanderDamage].map(([key, n]) => {
    const [seat, ...name] = key.split(':');
    const from = g.players[+seat];
    return `${n} from ${shortName(from)}${from.deck.commanders.length > 1 ? ` (${name.join(':')})` : ''}`;
  });
  const active = g.activeSeat === p.seat && !g.over;

  return (
    <div className={`mat ${me ? 'you' : ''} ${active ? 'active' : ''} ${p.alive ? '' : 'out'} ${target ? 'focus' : ''}`} data-fx={`mat:${p.seat}`}>
      <div className="mat-head">
        <div>
          <strong>{me ? 'You' : shortName(p)}</strong>{active && <span className="turn-chip">turn</span>}
          {!me && <div className="muted small">{commanderNames(p.deck)}</div>}
        </div>
        <div className="mat-head-right">
          {target && <button className="primary" onClick={target}>Target</button>}
          <div className="mat-life" title="Life total" data-fx={`life:${p.seat}`}>{p.alive ? p.life : '✕'}</div>
        </div>
      </div>
      {!p.alive ? <div className="muted small empty-board">Eliminated</div> : (
        <>
          <div className="mat-meta small muted">
            <span title="Cards in hand" data-fx={`handc:${p.seat}`}>✋ {p.hand.length}</span>
            <span title="Cards in library" data-fx={`lib:${p.seat}`}>📚 {p.library.length}</span>
            <span title={`Graveyard: ${p.graveyard.map((c) => c.name).join(', ') || 'empty'}`} data-fx={`gy:${p.seat}`}>🪦 {p.graveyard.length}</span>
            {p.exile.length > 0 && <span title={`Exile: ${p.exile.map((c) => c.name).join(', ')}`} data-fx={`ex:${p.seat}`}>⛔ {p.exile.length}</span>}
            {p.treasures > 0 && <span title="Treasure tokens">💰 {p.treasures}</span>}
            {p.poison > 0 && <span title="Poison counters: ten lose the game" data-fx={`poison:${p.seat}`}>☠ {p.poison}</span>}
            {p.energy > 0 && <span title="Energy counters">⚡ {p.energy}</span>}
            {g.monarch === p.seat && <span title="The monarch draws a card at each of their end steps">👑</span>}
            {damage.length > 0 && <span>Commander damage: {damage.join(', ')}</span>}
          </div>
          <div className="land-row">
            {lands.length === 0 && <span className="muted small">No lands</span>}
            {[...landGroups.values()].map((l) => (
              <div key={`${l.name}|${l.tapped}`} className={`board-card land ${l.tapped ? 'tapped' : ''}`} title={`${l.name}${l.n > 1 ? ` ×${l.n}` : ''}${l.tapped ? ' (tapped)' : ''}`}
                data-fx={`land:${p.seat}:${l.name}|${l.tapped}`} data-fx-card={l.n} data-fx-name={l.name}>
                <CardFace name={l.name} imageUrl={l.card.imageUrl ?? null} pt={null} {...bind(l.card.imageUrl ?? cardImage(l.name))} />
                {l.n > 1 && <span className="land-count">×{l.n}</span>}
              </div>
            ))}
          </div>
          <div className="card-row">
            {p.commandZone.map((card, i) => {
              const s = me ? cardState(card, 'command') : { cls: '' };
              const tax = g.commanderTax(p, card, true);
              return (
                <div key={`cz${i}`} className={`board-card command ${s.cls}`} onClick={s.onClick} title={`${card.name} — in the command zone${tax ? `, costs {${tax}} more` : ''}`}
                  data-fx={`cmd:${p.seat}:${cardKey(card)}`} data-fx-card={cardKey(card)} data-fx-name={card.name} data-fx-img={card.imageUrl ?? ''}>
                  <CardFace name={card.name} imageUrl={card.imageUrl ?? null} pt={null} {...bind(card.imageUrl ?? cardImage(card.name))} />
                  <span className="cmdr-badge">CMDR</span>
                  <span className="zone-badge">command zone{tax ? ` +${tax}` : ''}</span>
                </div>
              );
            })}
            {creatures.map((perm) => <PermCard key={perm.id} g={g} perm={perm} bind={bind} state={permState(perm)} badge={badge(perm)} />)}
          </div>
          {others.length > 0 && <div className="card-row others">{others.map((perm) => <PermCard key={perm.id} g={g} perm={perm} bind={bind} state={permState(perm)} badge={badge(perm)} />)}</div>}
        </>
      )}
    </div>
  );
}

function PermCard({ g, perm, bind, state, badge }: { g: Game; perm: Perm; bind: Bind; state: { cls: string; onClick?: () => void }; badge: string | null }) {
  const card = perm.card;
  const host = g.findPerm(perm.attachedTo);
  const attached = g.attachments(perm).map((q) => q.card.name);
  const keywords = ['flying', 'trample', 'haste', 'vigilance', 'deathtouch', 'lifelink', 'menace', 'first strike', 'double strike', 'indestructible', 'hexproof', 'reach', 'defender', 'ward'].filter((k) => g.hasKw(perm, k));
  const pt = card.isCreature ? `${g.power(perm)}/${g.toughness(perm)}${perm.damage ? ` (${perm.damage} dmg)` : ''}` : null;
  const title = [
    card.name,
    card.typeLine,
    perm.faceDown && perm.seat === ME && `Face down: it is your ${perm.faceDown.name}`,
    perm.parts && `Mutated: ${perm.parts.map((x) => x.face.name).join(' over ')}`,
    perm.tapped && 'Tapped',
    perm.sick && card.isCreature && 'Summoning sick',
    keywords.length && keywords.join(', '),
    g.protections(perm).length > 0 && g.protections(perm).map(describeProtection).join(', '),
    perm.suspected && "Suspected: menace, can't block",
    perm.counters > 0 && `${perm.counters} +1/+1 counter${perm.counters > 1 ? 's' : ''}`,
    perm.charge && `${perm.charge} ${(perm.printed ?? card).counterName ?? 'charge'} counter${perm.charge > 1 ? 's' : ''}`,
    perm.loyalty !== undefined && card.isPlaneswalker && `Loyalty ${perm.loyalty}`,
    perm.defense !== undefined && `Battle: defense ${perm.defense}${perm.protector !== undefined ? `, protected by ${shortName(g.players[perm.protector])}` : ''}`,
    perm.fogged && 'Combat damage to and from it is prevented this turn',
    perm.lore && `Lore ${perm.lore} of ${card.saga}`,
    perm.hours && `${perm.hours} hour counter${perm.hours > 1 ? 's' : ''}`,
    perm.kicked && (card.kicker?.multi ? `Kicked ${perm.kicked} time${perm.kicked > 1 ? 's' : ''}` : card.kicker?.offspring ? 'Offspring paid' : 'Kicked'),
    perm.fragile && `Sacrificed when it becomes the target of a spell${perm.fragile === 'any' ? ' or ability' : ''}`,
    perm.level && `Level ${perm.level}`,
    perm.goadedBy?.length && `Goaded by ${perm.goadedBy.map((s) => shortName(g.players[s])).join(', ')}`,
    attached.length && `Attached: ${attached.join(', ')}`,
    host && `Attached to ${host.card.name}`,
    card.notes.length ? `Plays as: ${card.notes.join('; ')}` : '',
    `Threat ${threat(g, perm).toFixed(0)}`,
  ].filter(Boolean).join('\n');
  return (
    <div className={`board-card ${perm.tapped ? 'tapped' : ''} ${perm.attacking !== null ? 'attacking' : ''} ${perm.blocking !== null ? 'blocking' : ''} ${state.cls}`} onClick={state.onClick} title={title}
      data-fx={`perm:${perm.id}`} data-fx-card={cardKey(perm.card)} data-fx-name={card.name} data-fx-img={card.imageUrl ?? ''}>
      <CardFace name={card.name} imageUrl={card.imageUrl ?? null} pt={pt} token={perm.token || !!perm.faceDown} {...bind(perm.token || perm.faceDown ? card.imageUrl ?? null : card.imageUrl ?? cardImage(card.name))} />
      {perm.isCommander && <span className="cmdr-badge">CMDR</span>}
      {perm.sick && card.isCreature && !g.hasKw(perm, 'haste') && <span className="sick-badge" title="Summoning sick">zZ</span>}
      {perm.counters > 0 && <span className="count-badge">+{perm.counters}</span>}
      {!!perm.charge && <span className="count-badge" title={`${(perm.printed ?? card).counterName ?? 'Charge'} counters`}>⚙{perm.charge}</span>}
      {!!perm.hours && <span className="count-badge" title="Hour counters">🕛{perm.hours}</span>}
      {perm.loyalty !== undefined && card.isPlaneswalker && <span className="count-badge" title="Loyalty">◆{perm.loyalty}</span>}
      {perm.defense !== undefined && <span className="count-badge" title={`Defense${perm.protector !== undefined ? `, protected by ${shortName(g.players[perm.protector])}` : ''}`}>⛨{perm.defense}</span>}
      {!card.modeled && <span className="nofx-badge" title="The engine can't interpret this card's text yet, so it has no effect in this game.">no effect</span>}
      {(badge || host || attached.length > 0) && <span className="zone-badge">{badge ?? (host ? `on ${host.card.name}` : `⚙ ${attached.join(', ')}`)}</span>}
    </div>
  );
}

/** A stable key per card in hand, so a card keeps its element (and its animation) as the hand changes. */
function handKeys(hand: SimCard[]): { card: SimCard; key: string }[] {
  const seen = new Map<number, number>();
  return hand.map((card) => {
    const id = cardKey(card);
    const n = seen.get(id) ?? 0;
    seen.set(id, n + 1);
    return { card, key: `hand:${id}:${n}` };
  });
}

function HandCard({ card, cls, onClick, bind, fxKey }: { card: SimCard; cls: string; onClick?: () => void; bind: Bind; fxKey: string }) {
  const title = `${card.name} ${card.isLand ? '' : costText(card)}\n${card.typeLine}\n${card.notes.length ? `Plays as: ${card.notes.join('; ')}` : ''}`;
  return (
    <div className={`board-card hand ${cls}`} onClick={onClick} title={title} data-fx={fxKey} data-fx-card={cardKey(card)} data-fx-name={card.name} data-fx-img={card.imageUrl ?? ''}>
      <CardFace name={card.name} imageUrl={card.imageUrl ?? null} pt={card.isCreature ? `${card.power}/${card.toughness}` : null} {...bind(card.imageUrl ?? cardImage(card.name))} />
      {!card.modeled && <span className="nofx-badge" title="The engine can't interpret this card's text yet, so it has no effect in this game.">no effect</span>}
    </div>
  );
}
