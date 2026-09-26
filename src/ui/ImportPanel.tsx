import { useState } from 'react';
import type { SimDeck } from '../engine/types';
import { importArchidekt } from '../import/archidekt';
import { importText } from '../import/text';

export function ImportPanel({ onImported }: { onImported: (deck: SimDeck) => void }) {
  const [mode, setMode] = useState<'archidekt' | 'text'>('archidekt');
  const [urls, setUrls] = useState('');
  const [name, setName] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [messages, setMessages] = useState<{ ok: boolean; text: string }[]>([]);

  async function importUrls() {
    const lines = urls.split(/[\s,]+/).map((l) => l.trim()).filter(Boolean);
    if (!lines.length) return;
    setBusy(true);
    const out: { ok: boolean; text: string }[] = [];
    for (const line of lines) {
      try {
        const deck = await importArchidekt(line);
        onImported(deck);
        out.push({ ok: true, text: `Imported “${deck.name}”` });
      } catch (err) {
        out.push({ ok: false, text: `${line}: ${(err as Error).message}` });
      }
    }
    setMessages(out);
    if (out.every((m) => m.ok)) setUrls('');
    setBusy(false);
  }

  async function importPasted() {
    setBusy(true);
    try {
      const deck = await importText(name.trim(), text);
      onImported(deck);
      setMessages([{ ok: true, text: `Imported “${deck.name}”` }]);
      setText('');
      setName('');
    } catch (err) {
      setMessages([{ ok: false, text: (err as Error).message }]);
    }
    setBusy(false);
  }

  async function onFiles(files: FileList | null) {
    if (!files?.length) return;
    setBusy(true);
    const out: { ok: boolean; text: string }[] = [];
    for (const file of Array.from(files)) {
      try {
        const deck = await importText(file.name.replace(/\.[^.]+$/, ''), await file.text());
        onImported(deck);
        out.push({ ok: true, text: `Imported “${deck.name}”` });
      } catch (err) {
        out.push({ ok: false, text: `${file.name}: ${(err as Error).message}` });
      }
    }
    setMessages(out);
    setBusy(false);
  }

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Add decks</h2>
        <div className="seg">
          <button className={mode === 'archidekt' ? 'active' : ''} onClick={() => setMode('archidekt')}>Archidekt link</button>
          <button className={mode === 'text' ? 'active' : ''} onClick={() => setMode('text')}>Decklist file / text</button>
        </div>
      </div>

      {mode === 'archidekt' ? (
        <div className="import-row">
          <textarea
            rows={2}
            placeholder={'https://archidekt.com/decks/1234567/my_deck\n(one or more links or deck ids — the deck must be public or unlisted)'}
            value={urls}
            onChange={(e) => setUrls(e.target.value)}
          />
          <button className="primary" disabled={busy || !urls.trim()} onClick={importUrls}>
            {busy ? 'Importing…' : 'Import'}
          </button>
        </div>
      ) : (
        <div className="import-text">
          <label className="file-drop">
            <input type="file" accept=".txt,.dek,.dec,text/plain" multiple onChange={(e) => onFiles(e.target.files)} />
            <span>Upload exported decklists (.txt) — one deck per file</span>
          </label>
          <div className="or">or paste one</div>
          <input placeholder="Deck name" value={name} onChange={(e) => setName(e.target.value)} />
          <textarea
            rows={8}
            placeholder={'Commander\n1 Atraxa, Praetors\' Voice\n\nDeck\n1 Sol Ring\n1 Arcane Signet\n...\n\nArchidekt exports like "1x Sol Ring (cmm) 400 [Ramp]" work too. Mark the commander with a "Commander" heading, a [Commander] tag, or *CMDR*.'}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <button className="primary" disabled={busy || !text.trim()} onClick={importPasted}>
            {busy ? 'Looking up cards…' : 'Import decklist'}
          </button>
        </div>
      )}

      {messages.length > 0 && (
        <ul className="messages">
          {messages.map((m, i) => (
            <li key={i} className={m.ok ? 'ok' : 'err'}>{m.text}</li>
          ))}
        </ul>
      )}
    </section>
  );
}
