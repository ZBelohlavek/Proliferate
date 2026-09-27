// A tabletop picture of a quiz situation: the cards the question is about,
// shown large, then every player's battlefield and your hand as card images.

import { useState } from 'react';
import type { HandCardView, PermView, PlayerView, Scenario } from '../ai/scenario';

interface Preview {
  url: string;
  x: number;
  y: number;
}

/** Hover any card to see it large. */
function usePreview() {
  const [preview, setPreview] = useState<Preview | null>(null);
  const bind = (url: string | null) =>
    url
      ? {
          onMouseEnter: (e: React.MouseEvent) => setPreview({ url, x: e.clientX, y: e.clientY }),
          onMouseMove: (e: React.MouseEvent) => setPreview({ url, x: e.clientX, y: e.clientY }),
          onMouseLeave: () => setPreview(null),
        }
      : {};
  const view = preview && (
    <img
      className="card-preview"
      src={preview.url}
      alt=""
      style={{
        left: Math.min(preview.x + 18, window.innerWidth - 270),
        top: Math.max(8, Math.min(preview.y - 170, window.innerHeight - 360)),
      }}
    />
  );
  return { bind, view };
}

export function BoardView({ scenario }: { scenario: Scenario }) {
  const { bind, view } = usePreview();
  const you = scenario.players.find((p) => p.you)!;
  const opponents = scenario.players.filter((p) => !p.you);

  return (
    <div className="tabletop">
      {view}

      <div className="spotlight">
        {scenario.spotlight.map((c, i) => (
          <div key={i} className="spotlight-item">
            {i > 0 && <span className="spotlight-join">{scenario.spotlightJoin}</span>}
            <figure>
              <CardFace name={c.name} imageUrl={c.imageUrl} pt={c.pt} big {...bind(c.imageUrl)} />
              <figcaption>{c.label}</figcaption>
            </figure>
          </div>
        ))}
      </div>

      <div className="mats">
        {opponents.map((p) => <Mat key={p.seat} p={p} bind={bind} />)}
      </div>
      <Mat p={you} bind={bind} />

      <div className="hand-mat">
        <div className="mat-head">
          <strong>Your hand</strong>
          <span className="muted small">{scenario.mana} mana available</span>
        </div>
        <div className="card-row">
          {scenario.hand.map((c, i) => <HandCard key={i} c={c} bind={bind} />)}
        </div>
      </div>
    </div>
  );
}

type Bind = (url: string | null) => object;

function Mat({ p, bind }: { p: PlayerView; bind: Bind }) {
  return (
    <div className={`mat ${p.you ? 'you' : ''} ${p.focus ? 'focus' : ''}`}>
      <div className="mat-head">
        <div>
          <strong>{p.you ? 'You' : p.deckName}</strong>
          <div className="muted small">{p.commander}</div>
        </div>
        <div className="mat-life" title="Life total">{p.life}</div>
      </div>
      <div className="mat-meta small muted">
        <span title="Lands (untapped)">🏔 {p.lands} ({p.untappedLands} untapped)</span>
        <span title="Cards in hand">✋ {p.hand}</span>
        <span title="Cards in library">📚 {p.library}</span>
        {p.commanderDamage.length > 0 && <span>Commander damage: {p.commanderDamage.join(', ')}</span>}
      </div>
      {p.creatures.length === 0 && p.others.length === 0 && <div className="muted small empty-board">No permanents besides lands</div>}
      {p.creatures.length > 0 && <div className="card-row">{p.creatures.map((c, i) => <BoardCard key={i} c={c} bind={bind} />)}</div>}
      {p.others.length > 0 && <div className="card-row others">{p.others.map((c, i) => <BoardCard key={i} c={c} bind={bind} />)}</div>}
    </div>
  );
}

function BoardCard({ c, bind }: { c: PermView; bind: Bind }) {
  const status = [c.tapped && 'tapped', c.sick && 'summoning sick', ...c.keywords].filter(Boolean).join(', ');
  return (
    <div className={`board-card ${c.tapped ? 'tapped' : ''} ${c.focus ? 'focus' : ''}`} title={`${c.name}${status ? ` — ${status}` : ''}\n${c.detail}`}>
      <CardFace name={c.name} imageUrl={c.imageUrl} pt={c.pt} token={c.token} {...bind(c.imageUrl)} />
      {c.count > 1 && <span className="count-badge">×{c.count}</span>}
      {c.commander && <span className="cmdr-badge">CMDR</span>}
      {c.sick && <span className="sick-badge" title="Summoning sick">zZ</span>}
    </div>
  );
}

function HandCard({ c, bind }: { c: HandCardView; bind: Bind }) {
  return (
    <div className={`board-card hand ${c.hypothetical ? 'hypothetical' : ''}`} title={`${c.name} ${c.cost}\n${c.detail}`}>
      <CardFace name={c.name} imageUrl={c.imageUrl} pt={null} {...bind(c.imageUrl)} />
      {c.hypothetical && <span className="hypo-badge">for this question</span>}
    </div>
  );
}

/** A card image, or a plain frame with the name for tokens / missing images. */
function CardFace({ name, imageUrl, pt, token, big, ...handlers }: { name: string; imageUrl: string | null; pt: string | null; token?: boolean; big?: boolean } & object) {
  const [failed, setFailed] = useState(false);
  return (
    <div className={`card-face ${big ? 'big' : ''}`} {...handlers}>
      {imageUrl && !failed ? (
        <img src={imageUrl} alt={name} loading="lazy" onError={() => setFailed(true)} />
      ) : (
        <div className={`card-frame ${token ? 'token' : ''}`}>
          <span>{name}</span>
          {token && <em>token</em>}
        </div>
      )}
      {pt && <span className="pt-badge">{pt}</span>}
    </div>
  );
}
