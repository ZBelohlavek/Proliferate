import { useMemo, useState } from 'react';
import type { SimDeck } from '../engine/types';
import { BRACKET_NAMES, estimateBracket } from '../analysis/bracket';
import { cardReport, type CardPerformance, type Verdict } from '../analysis/cards';
import type { Stats } from '../sim/stats';
import { commanderNames } from './format';
import { useBracketData } from './useBracket';
import { Help, SpellbookTag } from './Help';

interface Props {
  decks: SimDeck[];
  deckId: string | null;
  onDeck: (id: string) => void;
  stats: Stats;
}

const VERDICT_LABEL: Record<Verdict, string> = {
  weak: 'Weaker than your other cards',
  strong: 'Stronger than your other cards',
  neutral: 'About average',
  unknown: 'Not enough data',
};

type SortKey = 'impact' | 'name' | 'seen' | 'cmc';

export function DeckReport({ decks, deckId, onDeck, stats }: Props) {
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
      <BracketSection deck={deck} stats={stats} />
      <CardSection deck={deck} stats={stats} />
    </>
  );
}

function BracketSection({ deck, stats }: { deck: SimDeck; stats: Stats }) {
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
        const est = estimateBracket(st.data, stats.decks[deck.id]);
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

function CardSection({ deck, stats }: { deck: SimDeck; stats: Stats }) {
  const [hideLands, setHideLands] = useState(true);
  const [sort, setSort] = useState<{ key: SortKey; asc: boolean }>({ key: 'impact', asc: true });
  const report = cardReport(stats, deck);

  const rows = report.rows.filter((r) => !hideLands || !r.card.isLand);
  const value = (r: CardPerformance): number | string => {
    switch (sort.key) {
      case 'name': return r.name;
      case 'seen': return r.seen;
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

  const weak = report.rows.filter((r) => r.verdict === 'weak' && !r.card.isLand).sort((a, b) => (a.impact ?? 0) - (b.impact ?? 0));
  const maxAbs = Math.max(5, ...rows.map((r) => Math.abs(r.impact ?? 0) + (r.margin ?? 0)));

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Card performance <Help>
          Which cards pull their weight compared with the rest of this deck, from Forge games.
          <br /><br /><strong>Impact</strong> — how much better (+) or worse (−) the deck finishes in games where it cast the card, compared with a typical card in the same deck. Finish score runs from 100 (won) to 0 (first out). The bar is the 95% range: the true value is very probably inside it.
          <br /><br /><strong>Weak / Strong</strong> — the whole range is below / above the deck&apos;s typical card, so the difference is real, not luck.
          <br /><strong>About average</strong> — the range includes zero.
          <br /><strong>Not enough data</strong> — cast in too few (or too many) games to compare yet.
          <br /><br />Why &quot;compared with the rest of the deck&quot;? Forge&apos;s logs don&apos;t show draws, only casts, and decks that survive longer cast more cards — so every card looks good in absolute terms. Comparing cards with each other cancels that out.
        </Help></h2>
      </div>
      <p className="muted small">
        Impact compares each card with the deck&apos;s typical card (0 = typical). Bars show the 95% margin of error — a card is only called weak or strong when the whole bar is on one side of zero.
      </p>
      {report.notice && <p className="warn">{report.notice}</p>}

      {weak.length > 0 && (
        <div className="callout">
          <strong>Cards to look at:</strong>{' '}
          {weak.slice(0, 8).map((r, i) => (
            <span key={r.name}>{i > 0 && ', '}{r.name} <span className="muted small">({r.impact!.toFixed(1)})</span></span>
          ))}
        </div>
      )}

      <label className="muted small"><input type="checkbox" checked={hideLands} onChange={(e) => setHideLands(e.target.checked)} /> Hide lands</label>
      <div className="table-wrap">
        <table className="cards-table">
          <thead>
            <tr>
              {header('name', 'Card')}
              {header('cmc', 'MV')}
              {header('seen', 'Games cast', 'Games where the deck cast (or, for lands, played) the card')}
              {header('impact', 'Impact vs. deck', 'Finish-score difference vs. the deck’s typical card, with 95% margin of error')}
              <th>Verdict</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.name}>
                <td>{r.name}{r.count > 1 ? ` ×${r.count}` : ''}</td>
                <td className="num">{r.card.isLand ? '' : r.card.cmc}</td>
                <td className="num">{r.seen.toLocaleString()}</td>
                <td className="impact-cell">
                  {r.impact === null ? <span className="muted">—</span> : <ImpactBar impact={r.impact} margin={r.margin!} max={maxAbs} />}
                </td>
                <td><span className={`verdict v-${r.verdict}`}>{VERDICT_LABEL[r.verdict]}</span></td>
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
