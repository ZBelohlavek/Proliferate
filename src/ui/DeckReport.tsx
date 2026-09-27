import { useMemo, useState } from 'react';
import type { SimDeck } from '../engine/types';
import { BRACKET_NAMES, estimateBracket } from '../analysis/bracket';
import { cardReport, type Basis, type CardPerformance, type Verdict } from '../analysis/cards';
import type { Stats } from '../sim/stats';
import { commanderNames, pct } from './format';
import { useBracketData } from './useBracket';
import { Help, SpellbookTag } from './Help';

interface Props {
  decks: SimDeck[];
  deckId: string | null;
  onDeck: (id: string) => void;
  quickStats: Stats;
  forgeStats: Stats;
}

const VERDICT_LABEL: Record<Verdict, string> = {
  weak: 'Weak',
  strong: 'Strong',
  dead: 'Often stuck in hand',
  neutral: 'No clear effect',
  unknown: 'Not enough data',
};

type SortKey = 'impact' | 'name' | 'seen' | 'castRate' | 'cmc';

export function DeckReport({ decks, deckId, onDeck, quickStats, forgeStats }: Props) {
  const deck = decks.find((d) => d.id === deckId) ?? decks[0];
  if (!deck) return <section className="panel empty"><p>Import a deck first.</p></section>;

  return (
    <>
      <section className="panel">
        <div className="panel-head">
          <h2>Deck report</h2>
          <select value={deck.id} onChange={(e) => onDeck(e.target.value)} style={{ maxWidth: 420 }}>
            {decks.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </div>
        <p className="muted small">{commanderNames(deck)}</p>
      </section>
      <BracketSection deck={deck} forgeStats={forgeStats} />
      <CardSection deck={deck} quickStats={quickStats} forgeStats={forgeStats} />
    </>
  );
}

function BracketSection({ deck, forgeStats }: { deck: SimDeck; forgeStats: Stats }) {
  const decks = useMemo(() => [deck], [deck]);
  const { states, refresh } = useBracketData(decks);
  const st = states[deck.id];

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Bracket <Help>
                  The official Commander Brackets (Wizards of the Coast, beta) describe what kind of game to expect:
                  <span className="help-list">
                    <span><strong>1 Exhibition</strong> — theme over power; games last 9+ turns</span>
                    <span><strong>2 Core</strong> — unoptimized, like most precons; 8+ turns</span>
                    <span><strong>3 Upgraded</strong> — strong synergy, up to 3 Game Changers; 6+ turns</span>
                    <span><strong>4 Optimized</strong> — fast and lethal, any Game Changers; 4+ turns</span>
                    <span><strong>5 cEDH</strong> — tuned for the competitive metagame; any turn</span>
                  </span>
                  <br />The only hard rule is the number of <strong>Game Changers</strong> (a list of 53 especially powerful cards). Combos, extra turns and land destruction push a deck up, and so does winning fast in Forge games.
                </Help></h2>
        <button onClick={() => refresh(deck)} disabled={st?.loading}>Re-check</button>
      </div>
      {!st || st.loading ? <p className="muted">Checking Game Changers and combos with Commander Spellbook…</p> : null}
      {st?.error && <p className="err">{st.error}</p>}
      {st?.data && (() => {
        const est = estimateBracket(st.data, forgeStats.decks[deck.id]);
        return (
          <div className="bracket">
            <div className="bracket-head">
              <span className={`bracket-badge big b${est.bracket}`}>{est.bracket}</span>
              <div>
                <strong>{BRACKET_NAMES[est.bracket]}</strong>{est.note && <span className="muted"> — {est.note}</span>}
                <div className="muted small">
                  Estimated from the official <a href="https://magic.wizards.com/en/formats/commander#brackets" target="_blank" rel="noreferrer">Commander Brackets</a> rules.
                  Commander Spellbook&apos;s own label for this deck: <SpellbookTag tag={st.data.spellbookTag} />.
                  {deck.archidektBracket ? <> You marked it <strong>Bracket {deck.archidektBracket}</strong> on Archidekt{deck.archidektBracket !== est.bracket ? ' — see the reasons below for the difference' : ''}.</> : null}
                </div>
              </div>
            </div>
            <p className="muted small">
              Why: <Help>Each line below is one thing found in the deck. The badge is the <strong>lowest bracket that finding allows</strong> — &quot;4+&quot; means it only fits Bracket 4 or higher, &quot;ok&quot; means it fits any bracket. The deck&apos;s bracket is the highest of these.</Help>
            </p>
            <ul className="reasons">
              {est.reasons.map((r, i) => (
                <li key={i}><span className={`floor b${Math.max(r.floor, 1)}`}>{r.floor > 1 ? `${r.floor}+` : 'ok'}</span>{r.text}</li>
              ))}
            </ul>
            {!est.speed && (
              <p className="muted small">
                Speed check unavailable: the brackets are defined partly by how many turns a game lasts, and that needs full-rules games. Run the
                Accurate (Forge) engine until this deck has at least 8 wins to include it.
              </p>
            )}
            {est.bracket === 2 && (
              <p className="muted small">Bracket 1 (Exhibition) is about theme over power, so no deck list can prove it — if your deck is built around a theme first, call it a 1.</p>
            )}
            {st.data.combos.length > 0 && (
              <details>
                <summary>{st.data.combos.length} known combo{st.data.combos.length > 1 ? 's' : ''} in this deck</summary>
                <ul className="combo-list">
                  {st.data.combos.map((c, i) => (
                    <li key={i}>
                      <strong>{c.cards.join(' + ')}</strong> <span className="muted small">({c.manaValue} mana{c.tag ? `, ${c.tag}` : ''})</span>
                      <div className="small muted">{c.results.join(', ')}</div>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        );
      })()}
    </section>
  );
}

function CardSection({ deck, quickStats, forgeStats }: { deck: SimDeck; quickStats: Stats; forgeStats: Stats }) {
  const [basis, setBasis] = useState<Basis>('early');
  const [hideLands, setHideLands] = useState(true);
  const [sort, setSort] = useState<{ key: SortKey; asc: boolean }>({ key: 'impact', asc: true });
  const report = cardReport(basis === 'early' ? quickStats : forgeStats, deck, basis);

  const rows = report.rows.filter((r) => !hideLands || !r.card.isLand);
  const value = (r: CardPerformance): number | string => {
    switch (sort.key) {
      case 'name': return r.name;
      case 'seen': return r.seen;
      case 'castRate': return r.castRate ?? -1;
      case 'cmc': return r.card.cmc;
      default: return r.impact ?? (sort.asc ? Infinity : -Infinity);
    }
  };
  rows.sort((a, b) => {
    const va = value(a);
    const vb = value(b);
    const cmp = typeof va === 'string' ? va.localeCompare(vb as string) : (va as number) - (vb as number);
    return sort.asc ? cmp : -cmp;
  });
  const header = (key: SortKey, label: string, title?: string) => (
    <th title={title} className="sortable" onClick={() => setSort((s) => ({ key, asc: s.key === key ? !s.asc : key === 'name' }))}>
      {label}{sort.key === key ? (sort.asc ? ' ▲' : ' ▼') : ''}
    </th>
  );

  // In the quick engine, cards it can't read are played as blanks, so their numbers say nothing about the real card.
  const blank = (r: CardPerformance) => basis === 'early' && !r.card.modeled;
  const weak = report.rows
    .filter((r) => (r.verdict === 'weak' || r.verdict === 'dead') && !r.card.isLand && !blank(r))
    .sort((a, b) => (a.impact ?? 0) - (b.impact ?? 0));
  const blanks = report.rows.filter((r) => blank(r) && !r.card.isLand);
  const maxAbs = Math.max(5, ...rows.map((r) => Math.abs(r.impact ?? 0) + (r.margin ?? 0)));

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Card performance <Help>
          How much better or worse the deck does in games where each card shows up.
          <br /><br /><strong>Impact</strong> — difference in finish score (100 = won, 0 = first out) between games with and without the card early. +5 means the deck does 5 points better with it. The bar is the 95% range: the true effect is very probably inside it.
          <br /><br /><strong>Weak / Strong</strong> — the whole range is below / above zero, so the effect is real, not luck.
          <br /><strong>No clear effect</strong> — the range crosses zero; could be either.
          <br /><strong>Often stuck in hand</strong> — cast in under 35% of the games it was drawn: often uncastable or not worth casting.
          <br /><strong>Not enough data</strong> — needs more games.
        </Help></h2>
        <div className="seg">
          <button className={basis === 'early' ? 'active' : ''} onClick={() => setBasis('early')}>Quick engine</button>
          <button className={basis === 'cast' ? 'active' : ''} onClick={() => setBasis('cast')}>Forge (when cast)</button>
        </div>
      </div>
      <p className="muted small">
        {basis === 'early'
          ? "Impact compares how well the deck finishes (100 = win, 0 = first out) in games where the shuffle put the card in the opening hand or the next 8 cards, against games where it didn't. That's pure luck, so it's a fair test — but it only reflects how the quick engine plays the card."
          : "Impact compares games where Forge cast the card against games where it didn't. Forge doesn't log draws, so this is much weaker evidence: decks that survive longer cast more cards, so most cards look good. Use it to rank cards against each other, not as absolute numbers."}
        {' '}Bars show the 95% margin of error — a card is only called weak or strong when the whole bar is on one side of zero.
      </p>
      {report.notice && <p className="warn">{report.notice}</p>}

      {weak.length > 0 && (
        <div className="callout">
          <strong>Cards to look at:</strong>{' '}
          {weak.slice(0, 8).map((r, i) => (
            <span key={r.name}>{i > 0 && ', '}{r.name} <span className="muted small">({r.verdict === 'dead' ? `cast ${pct(r.castRate ?? 0, 0)} of the time` : `${r.impact!.toFixed(1)}`})</span></span>
          ))}
        </div>
      )}

      {blanks.length > 0 && (
        <p className="muted small">
          Not judged: {blanks.map((r) => r.name).join(', ')}. The quick engine can&apos;t read {blanks.length === 1 ? 'this card' : 'these cards'} and plays {blanks.length === 1 ? 'it' : 'them'} as blanks — use the Forge view for {blanks.length === 1 ? 'it' : 'them'}.
        </p>
      )}

      <label className="muted small"><input type="checkbox" checked={hideLands} onChange={(e) => setHideLands(e.target.checked)} /> Hide lands</label>
      <div className="table-wrap">
        <table className="cards-table">
          <thead>
            <tr>
              {header('name', 'Card')}
              {header('cmc', 'MV')}
              {header('seen', basis === 'early' ? 'Games early' : 'Games cast', basis === 'early' ? 'Games where the card was in the opening hand or the next 8 cards' : undefined)}
              {header('impact', 'Impact', 'Finish-score difference in points, with 95% margin of error')}
              {basis === 'early' && header('castRate', 'Cast when drawn', 'How often the card was cast in games where it was drawn')}
              <th>Verdict</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.name}>
                <td>
                  {r.name}{r.count > 1 ? ` ×${r.count}` : ''}
                  {!r.card.modeled && basis === 'early' && <span className="tag warn-tag" title="The quick engine doesn't understand this card and plays it as a blank">blank</span>}
                </td>
                <td className="num">{r.card.isLand ? '' : r.card.cmc}</td>
                <td className="num">{r.seen.toLocaleString()}</td>
                <td className="impact-cell">
                  {r.impact === null ? <span className="muted">—</span> : <ImpactBar impact={r.impact} margin={r.margin!} max={maxAbs} />}
                </td>
                {basis === 'early' && <td className="num">{r.castRate === null ? '—' : pct(r.castRate, 0)}</td>}
                <td>{blank(r) ? <span className="verdict v-unknown">Not judged (blank)</span> : <span className={`verdict v-${r.verdict}`}>{VERDICT_LABEL[r.verdict]}</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function ImpactBar({ impact, margin, max }: { impact: number; margin: number; max: number }) {
  const x = (v: number) => `${50 + (Math.max(-max, Math.min(max, v)) / max) * 50}%`;
  const lo = impact - margin;
  const hi = impact + margin;
  return (
    <div className="impact">
      <div className="impact-track">
        <span className="impact-zero" />
        <span className={`impact-range ${hi < 0 ? 'neg' : lo > 0 ? 'pos' : ''}`} style={{ left: x(lo), width: `calc(${x(hi)} - ${x(lo)})` }} />
        <span className="impact-dot" style={{ left: x(impact) }} />
      </div>
      <span className="num small">{impact > 0 ? '+' : ''}{impact.toFixed(1)}</span>
    </div>
  );
}
