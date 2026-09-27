import { useEffect, useRef, useState, type ReactNode } from 'react';

/** A small ⓘ button that opens an explanation. Click to open, click anywhere else to close. */
export function Help({ children, label = 'What does this mean?' }: { children: ReactNode; label?: string }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  const ref = useRef<HTMLSpanElement>(null);

  // Position against the window (not the parent) so scrolling tables can't clip it.
  const place = () => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    const width = Math.min(320, window.innerWidth - 24);
    const left = Math.min(Math.max(12, r.left + r.width / 2 - width / 2), window.innerWidth - width - 12);
    setPos({ top: r.bottom + 6, left });
  };

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const reposition = () => place();
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    window.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
      window.removeEventListener('scroll', reposition, true);
      window.removeEventListener('resize', reposition);
    };
  }, [open]);

  return (
    <span className="help" ref={ref}>
      <button
        type="button"
        className="help-btn"
        aria-label={label}
        aria-expanded={open}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          place();
          setOpen((o) => !o);
        }}
      >
        i
      </button>
      {open && <span className="help-pop" role="note" style={{ top: pos.top, left: pos.left }}>{children}</span>}
    </span>
  );
}

/**
 * Commander Spellbook's bracket labels, in their own words
 * (https://commanderspellbook.com/syntax-guide/). They rate a deck by its
 * strongest combo and map loosely onto the official brackets.
 */
export const SPELLBOOK_TAGS: { tag: string; bracket: string; meaning: string }[] = [
  { tag: 'Exhibition', bracket: 'any deck (Bracket 1)', meaning: "Combos that don't fit the other categories — casual, harmless." },
  { tag: 'Core', bracket: 'unoptimized decks (Bracket 2+)', meaning: 'An extra-turn card without an extra-turn loop, or a two-card combo a bit too fast for Bracket 1.' },
  { tag: 'Oddball', bracket: 'probably 2 or 3, hard to classify', meaning: "Could be Powerful, but needs a third card or doesn't produce a game-winning result." },
  { tag: 'Powerful', bracket: 'strong decks (Bracket 3+)', meaning: 'A combo involving a Game Changer, or a slow but relevant two-card combo.' },
  { tag: 'Spicy', bracket: 'probably 3 or 4, hard to classify', meaning: "Could be Ruthless, but needs a third card, doesn't produce a game-winning result, or stalls the game." },
  { tag: 'Ruthless', bracket: 'competitive decks (Bracket 4+)', meaning: 'A relevant two-card combo that is probably very fast, or infinite turns, mass land denial, controlling opponents, or four or more Game Changers.' },
  { tag: 'Banned', bracket: 'not legal', meaning: 'Uses a card banned in Commander.' },
];

/** A Commander Spellbook label with an explanation of it and the whole scale. */
export function SpellbookTag({ tag }: { tag: string }) {
  const info = SPELLBOOK_TAGS.find((t) => t.tag === tag);
  return (
    <span className="spellbook-tag">
      <strong>{tag}</strong>
      <Help label={`What does ${tag} mean?`}>
        <strong>Commander Spellbook&apos;s label</strong> — their own scale, based on the strongest combo in the deck (not the official bracket).
        {info && <><br /><br /><strong>{info.tag}</strong> ({info.bracket}): {info.meaning}</>}
        <br /><br />
        The full scale, least to most powerful:
        <span className="help-list">
          {SPELLBOOK_TAGS.map((t) => (
            <span key={t.tag} className={t.tag === tag ? 'current' : ''}><strong>{t.tag}</strong> — {t.bracket}</span>
          ))}
        </span>
      </Help>
    </span>
  );
}
