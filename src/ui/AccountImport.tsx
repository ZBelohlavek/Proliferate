import { useState } from 'react';
import type { SimDeck } from '../engine/types';
import { ARCHIDEKT_COMMANDER_FORMAT, importArchidekt, listArchidektDecks, type ArchidektDeckSummary } from '../import/archidekt';

interface Props {
  decks: SimDeck[];
  username: string;
  onUsername: (name: string) => void;
  onImported: (deck: SimDeck) => void;
}

type Status = 'new' | 'changed' | 'current';

/** Decks smaller than this are works in progress; don't pre-select them. */
const MIN_COMPLETE = 90;
const wanted = (d: ArchidektDeckSummary) => d.format === ARCHIDEKT_COMMANDER_FORMAT && d.size >= MIN_COMPLETE;

const STATUS_LABEL: Record<Status, string> = {
  new: 'New',
  changed: 'Changed on Archidekt',
  current: 'Imported',
};

/** Link an Archidekt username, list its public decks, and import or re-sync them. */
export function AccountImport({ decks, username, onUsername, onImported }: Props) {
  const [name, setName] = useState(username);
  const [list, setList] = useState<ArchidektDeckSummary[] | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [showAll, setShowAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [failures, setFailures] = useState<string[]>([]);

  const statusOf = (d: ArchidektDeckSummary): Status => {
    const mine = decks.find((x) => x.id === `archidekt-${d.id}`);
    if (!mine) return 'new';
    // Decks imported before sync existed don't know their Archidekt timestamp; fall back to the import time.
    const known = mine.archidektUpdatedAt ?? mine.importedAt;
    return d.updatedAt > known + 1000 ? 'changed' : 'current';
  };

  async function find() {
    setBusy(true);
    setError(null);
    setFailures([]);
    try {
      const found = await listArchidektDecks(name);
      setList(found);
      onUsername(name.trim());
      // Pre-select every Commander deck that's new or has changed.
      setChosen(new Set(found.filter((d) => wanted(d) && statusOf(d) !== 'current').map((d) => d.id)));
    } catch (err) {
      setError((err as Error).message);
      setList(null);
    }
    setBusy(false);
  }

  async function importChosen() {
    const ids = [...chosen];
    setBusy(true);
    setFailures([]);
    const failed: string[] = [];
    for (let i = 0; i < ids.length; i++) {
      setProgress({ done: i, total: ids.length });
      const summary = list?.find((d) => d.id === ids[i]);
      try {
        onImported(await importArchidekt(ids[i]));
      } catch (err) {
        failed.push(`${summary?.name ?? ids[i]}: ${(err as Error).message}`);
      }
      // Be gentle with Archidekt's servers.
      if (i < ids.length - 1) await new Promise((r) => setTimeout(r, 250));
    }
    setProgress(null);
    setFailures(failed);
    setChosen(new Set());
    setBusy(false);
  }

  const visible = (list ?? []).filter((d) => showAll || d.format === ARCHIDEKT_COMMANDER_FORMAT);
  const hidden = (list?.length ?? 0) - visible.length;
  const toggle = (id: string) => setChosen((s) => {
    const next = new Set(s);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });

  return (
    <div className="account-import">
      <div className="import-row">
        <input
          placeholder="Your Archidekt username (or profile link)"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && !busy && name.trim() && find()}
        />
        <button className="primary" disabled={busy || !name.trim()} onClick={find}>
          {busy && !progress ? 'Looking…' : list ? 'Refresh' : 'Find my decks'}
        </button>
      </div>
      <p className="muted small">
        Lists your <strong>public</strong> decks. Private and unlisted decks are hidden from everyone but you on Archidekt — import those by pasting their links in the &quot;Archidekt link&quot; tab.
      </p>
      {error && <p className="err">{error}</p>}

      {list && (
        <>
          <div className="account-bar">
            <span className="small">
              {visible.length} Commander deck{visible.length === 1 ? '' : 's'}
              {hidden > 0 && !showAll && <> · <button className="link" onClick={() => setShowAll(true)}>show {hidden} in other formats</button></>}
            </span>
            <span className="spacer" />
            <button className="link" onClick={() => setChosen(new Set(visible.map((d) => d.id)))}>Select all</button>
            <button className="link" onClick={() => setChosen(new Set(visible.filter((d) => wanted(d) && statusOf(d) !== 'current').map((d) => d.id)))}>New &amp; changed</button>
            <button className="link" onClick={() => setChosen(new Set())}>None</button>
            <button className="primary" disabled={busy || chosen.size === 0} onClick={importChosen}>
              {progress ? `Importing ${progress.done + 1} of ${progress.total}…` : `Import ${chosen.size} deck${chosen.size === 1 ? '' : 's'}`}
            </button>
          </div>
          {progress && <div className="progress"><span style={{ width: `${(progress.done / progress.total) * 100}%` }} /></div>}
          <ul className="account-list">
            {visible.map((d) => {
              const status = statusOf(d);
              return (
                <li key={d.id} className={chosen.has(d.id) ? 'on' : ''}>
                  <label>
                    <input type="checkbox" checked={chosen.has(d.id)} disabled={busy} onChange={() => toggle(d.id)} />
                    {d.image && <img src={d.image} alt="" loading="lazy" />}
                    <span className="al-main">
                      <span className="al-name">{d.name}</span>
                      <span className="muted small">
                        {d.size} cards · updated {new Date(d.updatedAt).toLocaleDateString()}
                        {d.bracket ? ` · Archidekt bracket ${d.bracket}` : ''}
                        {d.format !== ARCHIDEKT_COMMANDER_FORMAT ? ' · not a Commander deck' : d.size < MIN_COMPLETE ? ' · incomplete' : ''}
                      </span>
                    </span>
                    <span className={`al-status s-${status}`}>{STATUS_LABEL[status]}</span>
                  </label>
                </li>
              );
            })}
          </ul>
          {failures.length > 0 && (
            <ul className="messages">{failures.map((f, i) => <li key={i} className="err">{f}</li>)}</ul>
          )}
        </>
      )}
    </div>
  );
}
