// Motion and effects for the play table.
//
// This lives entirely in the UI. After every render that changed the game,
// `useTableFx` compares the table with what it showed last time and plays
// short animations for what happened in between: cards flying from hand to
// the stack to the battlefield, draws, taps, attacks, damage, deaths, exile,
// counters, triggers, life changes and the turn passing. The rules engine is
// only read, never called in a way that changes it, so simulations and their
// results are untouched.
//
// Animations use the Web Animations API on the real elements, plus short-lived
// "ghost" elements in a fixed overlay for cards that have already left the
// page (a creature that died is gone from the next render, so its ghost
// plays the death where it last stood).

import { useLayoutEffect, useRef, type RefObject } from 'react';
import type { SimCard } from '../engine/types';
import type { Game } from '../rules/game';

export type FxLevel = 'full' | 'quick' | 'off';

const LEVEL_KEY = 'proliferate.fx';

export function loadFxLevel(): FxLevel {
  try {
    const saved = localStorage.getItem(LEVEL_KEY);
    if (saved === 'full' || saved === 'quick' || saved === 'off') return saved;
  } catch { /* storage unavailable */ }
  const reduced = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  return reduced ? 'off' : 'full';
}

export function saveFxLevel(level: FxLevel) {
  try {
    localStorage.setItem(LEVEL_KEY, level);
  } catch { /* storage unavailable */ }
}

// ---------------------------------------------------------------------------
// What the table showed: one entry per tagged element, plus game facts
// ---------------------------------------------------------------------------

/** Card identity across zones: the same SimCard object keeps its number. */
const cardIds = new WeakMap<SimCard, number>();
let nextCardId = 1;
export function cardKey(card: SimCard): number {
  let id = cardIds.get(card);
  if (!id) cardIds.set(card, (id = nextCardId++));
  return id;
}

interface El {
  key: string;
  rect: DOMRect;
  /** cardKey of the card shown, for following it from zone to zone. */
  card: number;
  name: string;
  image: string | null;
}

interface PermFacts {
  seat: number;
  owner: number;
  card: SimCard;
  name: string;
  tapped: boolean;
  damage: number;
  counters: number;
  loyalty: number;
  power: number;
  toughness: number;
  attacking: number | null;
  blocking: number | null;
  token: boolean;
}

interface PlayerFacts {
  life: number;
  poison: number;
  alive: boolean;
  hand: number;
  graveyard: SimCard[];
  exile: SimCard[];
  hand0: SimCard[];
  library: SimCard[];
  commandZone: SimCard[];
}

interface Snapshot {
  els: Map<string, El>;
  perms: Map<number, PermFacts>;
  players: PlayerFacts[];
  stack: Map<number, { sourceId: number | null; kind: string }>;
  activeSeat: number;
  round: number;
  step: string;
  over: boolean;
}

function snapshot(root: HTMLElement, g: Game): Snapshot {
  const els = new Map<string, El>();
  root.querySelectorAll<HTMLElement>('[data-fx]').forEach((node) => {
    const key = node.dataset.fx!;
    els.set(key, {
      key,
      // A stack row is measured by its card picture, so cards fly to and from that.
      rect: (node.querySelector('.stack-thumb') ?? node).getBoundingClientRect(),
      card: +(node.dataset.fxCard ?? 0),
      name: node.dataset.fxName ?? '',
      image: node.dataset.fxImg || null,
    });
  });
  const perms = new Map<number, PermFacts>();
  for (const p of g.players) {
    for (const perm of p.battlefield) {
      const creature = perm.card.isCreature;
      perms.set(perm.id, {
        seat: perm.seat,
        owner: perm.owner ?? perm.seat,
        card: perm.card,
        name: perm.card.name,
        tapped: perm.tapped,
        damage: perm.damage,
        counters: perm.counters,
        loyalty: perm.loyalty ?? 0,
        power: creature ? g.power(perm) : 0,
        toughness: creature ? g.toughness(perm) : 0,
        attacking: perm.attacking,
        blocking: perm.blocking,
        token: perm.token,
      });
    }
  }
  return {
    els,
    perms,
    players: g.players.map((p) => ({
      life: p.life,
      poison: p.poison,
      alive: p.alive,
      hand: p.hand.length,
      hand0: [...p.hand],
      graveyard: [...p.graveyard],
      exile: [...p.exile],
      library: p.library.slice(0, 3),
      commandZone: [...p.commandZone],
    })),
    stack: new Map(g.stack.map((s) => [s.id, { sourceId: s.sourceId, kind: s.kind }])),
    activeSeat: g.activeSeat,
    round: g.round,
    step: g.step,
    over: g.over,
  };
}

// ---------------------------------------------------------------------------
// The hook
// ---------------------------------------------------------------------------

interface FxOptions {
  level: FxLevel;
  /** The person's seat. */
  me: number;
  /** Short player names, by seat. */
  names: string[];
}

/**
 * Plays the table's animations. `holdUntil` is raised to the time (from
 * performance.now) the effects just started will finish, so the bots can wait
 * for them before their next play.
 */
export function useTableFx(root: RefObject<HTMLElement | null>, g: Game, signature: string, opts: FxOptions, holdUntil: RefObject<number>) {
  const prev = useRef<Snapshot | null>(null);
  const lastSig = useRef('');

  useLayoutEffect(() => {
    const node = root.current;
    if (!node) return;
    if (signature === lastSig.current && prev.current) return;
    lastSig.current = signature;
    const next = snapshot(node, g);
    const before = prev.current;
    prev.current = next;
    if (!before || opts.level === 'off') return;
    const fx = new Fx(node, opts.level === 'full' ? 1 : 0.55);
    try {
      play(fx, before, next, g, opts);
    } catch (e) {
      // An effect must never break the game screen.
      console.warn('table effect failed', e);
    }
    holdUntil.current = Math.max(holdUntil.current, performance.now() + fx.hold);
  });
}

// ---------------------------------------------------------------------------
// Working out what happened
// ---------------------------------------------------------------------------

function play(fx: Fx, a: Snapshot, b: Snapshot, g: Game, opts: FxOptions) {
  const { me, names } = opts;
  const big = Math.abs(b.els.size - a.els.size) > 30 || b.round - a.round > 1;

  // Turn and game over banners first: they frame everything else.
  if (b.over && !a.over) {
    const won = g.winner === me;
    fx.banner(won ? 'Victory' : g.winner === null ? 'Draw' : 'Defeat', won ? 'You win the game' : g.winner === null ? 'Nobody wins' : `${names[g.winner!]} wins`, won ? 'win' : 'lose', 2.2);
  } else if (b.round >= 1 && (b.activeSeat !== a.activeSeat || b.round !== a.round)) {
    fx.banner(b.activeSeat === me ? 'Your turn' : `${names[b.activeSeat]}'s turn`, `Round ${Math.max(1, b.round)}`, b.activeSeat === me ? 'mine' : 'theirs', 1);
  }
  if (big) return; // Skipped ahead (instant speed): only the banner.

  const appeared = [...b.els.keys()].filter((k) => !a.els.has(k));
  const vanished = new Map([...a.els].filter(([k]) => !b.els.has(k)));
  const isCardEl = (k: string) => /^(hand|stack|perm|cmd):/.test(k);

  // 1. Cards that moved between zones: follow them from their old spot.
  const used = new Set<string>();
  const findSource = (el: El): El | null => {
    let best: El | null = null;
    for (const v of vanished.values()) {
      if (used.has(v.key) || !isCardEl(v.key)) continue;
      if (el.card && v.card === el.card) return v;
      if (!best && el.name && v.name === el.name) best = v;
    }
    return best;
  };

  for (const key of appeared) {
    const el = b.els.get(key)!;
    const node = fx.node(key);
    if (!node) continue;
    if (key.startsWith('perm:') || key.startsWith('stack:') || key.startsWith('hand:') || key.startsWith('cmd:')) {
      const src = findSource(el);
      if (src) {
        used.add(src.key);
        const toStack = key.startsWith('stack:');
        const thumb = toStack ? node.querySelector<HTMLElement>('.stack-thumb') : null;
        if (thumb) fx.slideIn(node);
        fx.flyFrom(thumb ?? node, src.rect, el.rect, toStack ? 0.5 : 0.6);
        if (key.startsWith('perm:')) fx.later(0.55, () => fx.impact(el.rect, 'enter'));
        if (toStack) fx.glow(node, 'cast', 0.9);
        continue;
      }
    }
    if (key.startsWith('perm:')) {
      const id = +key.slice(5);
      const facts = b.perms.get(id);
      fx.materialize(node, facts?.token ? 'token' : 'enter');
      if (facts?.token) fx.sparkle(el.rect, 'token', 10);
    } else if (key.startsWith('stack:')) {
      const id = +key.slice(6);
      const item = b.stack.get(id);
      fx.slideIn(node);
      const srcKey = item?.sourceId != null ? `perm:${item.sourceId}` : null;
      const src = srcKey ? b.els.get(srcKey) ?? a.els.get(srcKey) : null;
      const srcNode = srcKey ? fx.node(srcKey) : null;
      if (srcNode) fx.glow(srcNode, 'trigger', 0.8);
      if (src) fx.orb(src.rect, el.rect, 'trigger');
      fx.glow(node, item?.kind === 'ability' ? 'trigger' : 'cast', 0.9);
    } else if (key.startsWith('hand:')) {
      // A draw: from the library pile into the hand, turning face up.
      const lib = b.els.get(`lib:${me}`) ?? a.els.get(`lib:${me}`);
      if (lib) fx.drawFrom(node, lib.rect, el.rect);
      else fx.materialize(node, 'enter');
    } else if (key.startsWith('land:')) {
      fx.pop(node, 'land');
    } else if (key.startsWith('cmd:')) {
      fx.materialize(node, 'enter');
    }
  }

  // 2. Cards that left without landing somewhere visible.
  const pileKey = (where: string, seat: number) => (where === 'graveyard' || where === 'discard' ? `gy:${seat}` : where === 'exile' ? `ex:${seat}` : where === 'library' ? `lib:${seat}` : `handc:${seat}`);
  for (const [key, el] of vanished) {
    if (used.has(key)) continue;
    if (key.startsWith('perm:')) {
      const facts = a.perms.get(+key.slice(5));
      if (!facts) continue;
      const where = destination(facts.card, facts.name, facts.owner, b, facts.token);
      const pile = pileKey(where, facts.owner);
      fx.leave(el, where, b.els.get(pile)?.rect ?? null, fx.node(pile));
    } else if (key.startsWith('stack:')) {
      // Resolved (or countered) without becoming a permanent.
      fx.resolve(el);
    } else if (key.startsWith('hand:')) {
      // Played as a land: fly to its chip in the land row.
      const land = [...b.els.values()].find((x) => x.key.startsWith(`land:${me}:`) && x.name === el.name && (!a.els.has(x.key) || x.card > a.els.get(x.key)!.card));
      if (land) {
        fx.leave(el, 'hand', land.rect, null);
        const chip = fx.node(land.key);
        if (chip) fx.later(0.45, () => fx.pop(chip, 'land'));
        continue;
      }
      const card = a.players[me].hand0.find((c) => cardKey(c) === el.card);
      const where = card ? destination(card, el.name, me, b, false) : 'gone';
      const shown = where === 'graveyard' ? 'discard' : where === 'gone' || where === 'hand' ? 'gone' : where;
      const pile = pileKey(shown, me);
      fx.leave(el, shown, b.els.get(pile)?.rect ?? null, fx.node(pile));
    }
  }

  // 3. Permanents that stayed but changed.
  const damageSources = recentSources(b, vanished);
  for (const [id, now] of b.perms) {
    const was = a.perms.get(id);
    if (!was) continue;
    const key = `perm:${id}`;
    const node = fx.node(key);
    const el = b.els.get(key);
    if (!node || !el) continue;
    if (now.tapped !== was.tapped) fx.tap(node, now.tapped);
    if (now.attacking !== null && was.attacking === null) {
      const target = b.els.get(`mat:${now.attacking}`);
      fx.lunge(node, el.rect, target?.rect ?? null, 'attack');
    }
    if (now.blocking !== null && was.blocking === null) {
      const target = b.els.get(`perm:${now.blocking}`);
      fx.lunge(node, el.rect, target?.rect ?? null, 'block');
    }
    if (now.damage > was.damage) {
      const hit = now.damage - was.damage;
      const from = combatPartner(id, a) ?? damageSources[0];
      if (from) fx.orb(from, el.rect, 'damage');
      fx.later(from ? 0.3 : 0, () => {
        fx.shake(node);
        fx.flash(node, 'damage');
        fx.float(el.rect, `−${hit}`, 'damage');
      });
    }
    const counters = now.counters - was.counters;
    if (counters !== 0) {
      fx.float(el.rect, `${counters > 0 ? '+' : '−'}${Math.abs(counters)}/${counters > 0 ? '+' : '−'}${Math.abs(counters)}`, counters > 0 ? 'counter' : 'damage');
      if (counters > 0) fx.sparkle(el.rect, 'counter', 6);
      const badge = node.querySelector<HTMLElement>('.count-badge');
      if (badge) fx.pop(badge, 'counter');
    } else if ((now.power !== was.power || now.toughness !== was.toughness) && now.damage === was.damage) {
      const dp = now.power - was.power;
      const dt = now.toughness - was.toughness;
      if (Math.abs(dp) + Math.abs(dt) > 0 && Math.abs(dp) + Math.abs(dt) < 40) {
        fx.float(el.rect, `${dp >= 0 ? '+' : '−'}${Math.abs(dp)}/${dt >= 0 ? '+' : '−'}${Math.abs(dt)}`, dp + dt >= 0 ? 'pump' : 'damage');
        const pt = node.querySelector<HTMLElement>('.pt-badge');
        if (pt) fx.pop(pt, dp + dt >= 0 ? 'counter' : 'land');
      }
    }
    if (now.loyalty !== was.loyalty && was.loyalty) {
      const d = now.loyalty - was.loyalty;
      fx.float(el.rect, `${d > 0 ? '+' : '−'}${Math.abs(d)} loyalty`, d > 0 ? 'counter' : 'damage');
    }
    if (now.seat !== was.seat) {
      const old = a.els.get(key);
      if (old) fx.flyFrom(node, old.rect, el.rect, 0.7);
      fx.glow(node, 'cast', 1);
    }
  }

  // 4. Players.
  for (let seat = 0; seat < b.players.length; seat++) {
    const was = a.players[seat];
    const now = b.players[seat];
    const lifeEl = b.els.get(`life:${seat}`);
    const lifeNode = fx.node(`life:${seat}`);
    const mat = fx.node(`mat:${seat}`);
    const diff = now.life - was.life;
    if (diff !== 0 && lifeEl && lifeNode) {
      if (diff < 0) {
        const attackers = [...a.perms.entries()].filter(([, p]) => p.attacking === seat).map(([pid]) => a.els.get(`perm:${pid}`)?.rect).filter((r): r is DOMRect => !!r);
        const sources = b.step === 'combatDamage' || a.step === 'combatDamage' ? attackers : damageSources;
        sources.slice(0, 6).forEach((r, i) => fx.later(i * 0.06, () => fx.orb(r, lifeEl.rect, 'damage')));
        fx.later(sources.length ? 0.32 : 0, () => {
          fx.float(lifeEl.rect, `−${-diff}`, 'damage', true);
          fx.pop(lifeNode, 'hurt');
          if (mat) fx.shake(mat, 0.5);
          if (seat === me) fx.vignette('hurt');
        });
      } else {
        fx.float(lifeEl.rect, `+${diff}`, 'heal', true);
        fx.pop(lifeNode, 'heal');
        fx.sparkle(lifeEl.rect, 'heal', 8);
      }
    }
    if (now.poison > was.poison) {
      const chip = b.els.get(`poison:${seat}`);
      if (chip) fx.float(chip.rect, `+${now.poison - was.poison} poison`, 'poison');
    }
    if (!now.alive && was.alive && mat) {
      fx.eliminated(mat);
    }
    // Opponents' draws: a card back slides from their library to their hand count.
    if (seat !== me && now.hand > was.hand) {
      const lib = b.els.get(`lib:${seat}`);
      const hand = b.els.get(`handc:${seat}`);
      if (lib && hand) fx.cardBack(lib.rect, hand.rect, Math.min(3, now.hand - was.hand));
    }
    // Land chips that grew (a land drop or a land untapping into a group).
    for (const [key, el] of b.els) {
      if (!key.startsWith(`land:${seat}:`)) continue;
      const old = a.els.get(key);
      if (old && el.card > old.card) {
        const node = fx.node(key);
        if (node) fx.pop(node, 'land');
      }
    }
  }
}

/** Where a card that left the battlefield or the hand went. */
function destination(card: SimCard, name: string, owner: number, b: Snapshot, token: boolean): 'graveyard' | 'exile' | 'hand' | 'library' | 'gone' {
  if (token) return 'gone';
  const o = b.players[owner];
  if (!o) return 'gone';
  const has = (zone: SimCard[]) => zone.includes(card) || zone.some((c) => c.name === name);
  if (has(o.graveyard.slice(-12))) return 'graveyard';
  if (has(o.exile.slice(-12))) return 'exile';
  if (has(o.hand0)) return 'hand';
  if (has(o.library)) return 'library';
  return 'gone';
}

/** The creature this one fought: the attacker it blocked, or a blocker of it. */
function combatPartner(id: number, a: Snapshot): DOMRect | null {
  const p = a.perms.get(id);
  if (!p) return null;
  if (p.blocking !== null) return a.els.get(`perm:${p.blocking}`)?.rect ?? null;
  for (const [other, q] of a.perms) if (q.blocking === id) return a.els.get(`perm:${other}`)?.rect ?? null;
  return null;
}

/** Spells and abilities that just left the stack: the likely source of damage or life change. */
function recentSources(b: Snapshot, vanished: Map<string, El>): DOMRect[] {
  const out: DOMRect[] = [];
  for (const [key, el] of vanished) if (key.startsWith('stack:') && !b.stack.has(+key.slice(6))) out.push(el.rect);
  return out;
}

// ---------------------------------------------------------------------------
// The effects
// ---------------------------------------------------------------------------

type Tone = 'enter' | 'exile' | 'token' | 'cast' | 'trigger' | 'damage' | 'heal' | 'counter' | 'pump' | 'poison' | 'land' | 'hurt';

let layer: HTMLDivElement | null = null;
function overlay(): HTMLDivElement {
  if (!layer || !layer.isConnected) {
    layer = document.createElement('div');
    layer.className = 'fx-layer';
    layer.setAttribute('aria-hidden', 'true');
    document.body.appendChild(layer);
  }
  return layer;
}

const EASE_OUT = 'cubic-bezier(0.2, 0.8, 0.2, 1)';
const EASE_IN = 'cubic-bezier(0.6, 0, 0.8, 0.4)';
const MAX_GHOSTS = 60;

class Fx {
  /** How long, in ms, the longest effect started here will run. */
  hold = 0;

  constructor(private readonly root: HTMLElement, private readonly pace: number) {}

  private ms(seconds: number): number {
    return Math.round(seconds * 1000 * this.pace);
  }

  private track(delay: number, duration: number) {
    this.hold = Math.max(this.hold, delay + duration);
  }

  node(key: string): HTMLElement | null {
    return this.root.querySelector<HTMLElement>(`[data-fx="${CSS.escape(key)}"]`);
  }

  later(seconds: number, run: () => void) {
    const ms = this.ms(seconds);
    if (ms <= 0) run();
    else window.setTimeout(run, ms);
  }

  private animate(el: Element, frames: Keyframe[], seconds: number, opts: KeyframeAnimationOptions = {}): Animation | null {
    const duration = this.ms(seconds);
    const delay = typeof opts.delay === 'number' ? opts.delay : 0;
    this.track(delay, duration);
    if (typeof el.animate !== 'function') return null;
    return el.animate(frames, { duration, easing: EASE_OUT, fill: 'none', ...opts });
  }

  private ghost(cls: string, rect: { left: number; top: number; width: number; height: number }, html?: El | null): HTMLDivElement | null {
    const host = overlay();
    if (host.childElementCount > MAX_GHOSTS) return null;
    const div = document.createElement('div');
    div.className = `fx-ghost ${cls}`;
    div.style.left = `${rect.left}px`;
    div.style.top = `${rect.top}px`;
    div.style.width = `${rect.width}px`;
    div.style.height = `${rect.height}px`;
    if (html) {
      if (html.image) {
        const img = document.createElement('img');
        img.src = html.image;
        img.alt = '';
        div.appendChild(img);
      } else {
        const span = document.createElement('span');
        span.textContent = html.name;
        div.appendChild(span);
      }
    }
    host.appendChild(div);
    return div;
  }

  private done(anim: Animation | null, el: Element, fallbackMs: number) {
    if (anim) anim.onfinish = () => el.remove();
    else window.setTimeout(() => el.remove(), fallbackMs);
  }

  /** Move an element that just appeared from where its card was before (FLIP). */
  flyFrom(node: HTMLElement, from: DOMRect, to: DOMRect, seconds: number) {
    const dx = from.left + from.width / 2 - (to.left + to.width / 2);
    const dy = from.top + from.height / 2 - (to.top + to.height / 2);
    const sx = to.width ? Math.max(0.3, Math.min(3, from.width / to.width)) : 1;
    const sy = to.height ? Math.max(0.3, Math.min(3, from.height / to.height)) : 1;
    this.animate(
      node,
      [
        { transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`, zIndex: 5, filter: 'brightness(1.3) drop-shadow(0 10px 18px rgba(0,0,0,.45))' },
        { transform: `translate(${dx * 0.35}px, ${dy * 0.35 - 30}px) scale(${1.12})`, zIndex: 5, filter: 'brightness(1.25) drop-shadow(0 18px 24px rgba(0,0,0,.4))', offset: 0.55 },
        { transform: 'none', zIndex: 5, filter: 'none' },
      ],
      seconds,
    );
  }

  /** A permanent that appeared from nowhere visible: it drops onto the table. */
  materialize(node: HTMLElement, tone: 'enter' | 'token') {
    this.animate(
      node,
      [
        { transform: 'translateY(-26px) scale(1.25)', opacity: 0, filter: 'brightness(2) blur(2px)' },
        { transform: 'translateY(2px) scale(0.97)', opacity: 1, filter: 'brightness(1.4)', offset: 0.6 },
        { transform: 'none', opacity: 1, filter: 'none' },
      ],
      tone === 'token' ? 0.55 : 0.6,
    );
    const rect = node.getBoundingClientRect();
    this.later(0.35, () => this.impact(rect, tone));
  }

  /** A drawn card: from the library pile, flipping face up into the hand. */
  drawFrom(node: HTMLElement, lib: DOMRect, to: DOMRect) {
    const dx = lib.left + lib.width / 2 - (to.left + to.width / 2);
    const dy = lib.top + lib.height / 2 - (to.top + to.height / 2);
    this.animate(
      node,
      [
        { transform: `translate(${dx}px, ${dy}px) scale(0.35) rotateY(180deg)`, opacity: 0.2 },
        { transform: `translate(${dx * 0.4}px, ${dy * 0.4 - 24}px) scale(0.9) rotateY(90deg)`, opacity: 1, offset: 0.5 },
        { transform: 'translateY(-14px) scale(1.06) rotateY(0deg)', offset: 0.8 },
        { transform: 'none' },
      ],
      0.6,
    );
    const face = node.querySelector('.card-face');
    if (face) this.animate(face, [{ boxShadow: '0 0 0 2px #8ec5ff, 0 0 22px 6px rgba(120,190,255,.8)' }, { boxShadow: '0 0 0 0 transparent' }], 1.1);
  }

  /** A stack row arriving. */
  slideIn(node: HTMLElement) {
    this.animate(node, [{ transform: 'translateX(-40px) scale(0.96)', opacity: 0 }, { transform: 'none', opacity: 1 }], 0.38);
  }

  /** A coloured halo around a card for a moment. */
  glow(node: HTMLElement, tone: Tone, seconds: number) {
    const target = node.querySelector('.card-face') ?? node;
    const color = TONES[tone];
    this.animate(
      target,
      [
        { boxShadow: `0 0 0 2px ${color}, 0 0 28px 8px ${color}` },
        { boxShadow: `0 0 0 2px ${color}, 0 0 14px 3px ${color}`, offset: 0.5 },
        { boxShadow: '0 0 0 0 transparent' },
      ],
      seconds,
    );
  }

  /** A quick colour wash over a card. */
  flash(node: HTMLElement, tone: Tone) {
    const target = node.querySelector('.card-face') ?? node;
    this.animate(target, [{ filter: `brightness(1.6) sepia(1) hue-rotate(${tone === 'damage' ? '-50deg' : '60deg'}) saturate(4)` }, { filter: 'none' }], 0.45);
  }

  /** Tap or untap: the card turns on the table. */
  tap(node: HTMLElement, tapped: boolean) {
    const face = node.querySelector('.card-face');
    if (!face) return;
    this.animate(face, tapped ? [{ transform: 'rotate(0deg)' }, { transform: 'rotate(90deg)' }] : [{ transform: 'rotate(90deg)' }, { transform: 'rotate(0deg)' }], 0.3);
  }

  /** Attack or block: the creature leans toward its target and back. */
  lunge(node: HTMLElement, from: DOMRect, to: DOMRect | null, kind: 'attack' | 'block') {
    let dx = 0;
    let dy = kind === 'attack' ? -1 : 1;
    if (to) {
      dx = to.left + to.width / 2 - (from.left + from.width / 2);
      dy = to.top + to.height / 2 - (from.top + from.height / 2);
      const len = Math.hypot(dx, dy) || 1;
      dx /= len;
      dy /= len;
    }
    const reach = kind === 'attack' ? 34 : 22;
    this.animate(
      node,
      [
        { transform: 'none' },
        { transform: `translate(${-dx * 6}px, ${-dy * 6}px) scale(1.04)`, offset: 0.25 },
        { transform: `translate(${dx * reach}px, ${dy * reach}px) scale(1.1)`, offset: 0.55, zIndex: 5 },
        { transform: 'none' },
      ],
      0.55,
      { easing: 'ease-in-out' },
    );
    this.glow(node, kind === 'attack' ? 'damage' : 'cast', 0.8);
    if (kind === 'attack') {
      const r = node.getBoundingClientRect();
      this.later(0.28, () => this.sparkle(r, 'damage', 6));
    }
  }

  /** A hit: the element jolts. */
  shake(node: HTMLElement, strength = 1) {
    const s = 5 * strength;
    this.animate(
      node,
      [
        { transform: 'translateX(0)' },
        { transform: `translateX(${-s}px) rotate(-1deg)` },
        { transform: `translateX(${s}px) rotate(1deg)` },
        { transform: `translateX(${-s * 0.6}px)` },
        { transform: `translateX(${s * 0.4}px)` },
        { transform: 'translateX(0)' },
      ],
      0.4,
      { easing: 'linear' },
    );
  }

  /** A brief scale-up, for a badge, chip or life total. */
  pop(node: HTMLElement, tone: Tone) {
    const color = TONES[tone];
    this.animate(
      node,
      [
        { transform: 'scale(1)', boxShadow: '0 0 0 0 transparent' },
        { transform: 'scale(1.35)', boxShadow: `0 0 0 3px ${color}, 0 0 18px 4px ${color}`, offset: 0.3 },
        { transform: 'scale(1)', boxShadow: '0 0 0 0 transparent' },
      ],
      0.5,
    );
  }

  /** A number or word rising from a spot and fading. */
  float(rect: DOMRect, text: string, tone: Tone, big = false) {
    const div = this.ghost(`fx-float ${tone} ${big ? 'big' : ''}`, { left: rect.left + rect.width / 2, top: rect.top + rect.height / 2, width: 0, height: 0 });
    if (!div) return;
    div.textContent = text;
    const anim = this.animate(
      div,
      [
        { transform: 'translate(-50%, -50%) scale(0.6)', opacity: 0 },
        { transform: 'translate(-50%, -90%) scale(1.25)', opacity: 1, offset: 0.2 },
        { transform: 'translate(-50%, -180%) scale(1)', opacity: 1, offset: 0.7 },
        { transform: 'translate(-50%, -240%) scale(0.95)', opacity: 0 },
      ],
      big ? 1.3 : 1.1,
    );
    this.done(anim, div, this.ms(1.3));
  }

  /** A glowing mote travelling from one spot to another (damage, triggers). */
  orb(from: DOMRect, to: DOMRect, tone: Tone) {
    const div = this.ghost(`fx-orb ${tone}`, { left: from.left + from.width / 2 - 9, top: from.top + from.height / 2 - 9, width: 18, height: 18 });
    if (!div) return;
    const dx = to.left + to.width / 2 - (from.left + from.width / 2);
    const dy = to.top + to.height / 2 - (from.top + from.height / 2);
    const lift = -Math.min(80, Math.hypot(dx, dy) * 0.25);
    const anim = this.animate(
      div,
      [
        { transform: 'translate(0, 0) scale(0.4)', opacity: 0 },
        { transform: `translate(${dx * 0.5}px, ${dy * 0.5 + lift}px) scale(1.2)`, opacity: 1, offset: 0.5 },
        { transform: `translate(${dx}px, ${dy}px) scale(0.8)`, opacity: 1, offset: 0.92 },
        { transform: `translate(${dx}px, ${dy}px) scale(2.2)`, opacity: 0 },
      ],
      0.42,
      { easing: 'ease-in' },
    );
    this.done(anim, div, this.ms(0.5));
  }

  /** A ring expanding where something lands. */
  impact(rect: DOMRect, tone: Tone) {
    const size = Math.max(rect.width, rect.height);
    const div = this.ghost(`fx-ring ${tone}`, { left: rect.left + rect.width / 2 - size / 2, top: rect.top + rect.height / 2 - size / 2, width: size, height: size });
    if (!div) return;
    const anim = this.animate(div, [{ transform: 'scale(0.5)', opacity: 0.9 }, { transform: 'scale(1.6)', opacity: 0 }], 0.5);
    this.done(anim, div, this.ms(0.6));
  }

  /** Little sparks thrown out from a spot. */
  sparkle(rect: DOMRect, tone: Tone, count: number) {
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    for (let i = 0; i < count; i++) {
      const div = this.ghost(`fx-spark ${tone}`, { left: cx - 3, top: cy - 3, width: 6, height: 6 });
      if (!div) return;
      const angle = (Math.PI * 2 * i) / count + Math.random() * 0.6;
      const dist = 30 + Math.random() * 40;
      const anim = this.animate(
        div,
        [
          { transform: 'translate(0, 0) scale(1)', opacity: 1 },
          { transform: `translate(${Math.cos(angle) * dist}px, ${Math.sin(angle) * dist}px) scale(0.3)`, opacity: 0 },
        ],
        0.55 + Math.random() * 0.3,
        { delay: Math.random() * 80 },
      );
      this.done(anim, div, this.ms(0.9));
    }
  }

  /** A spell or ability leaving the stack without a permanent: a burst where it was. */
  resolve(el: El) {
    const g = this.ghost('fx-card resolve', el.rect, el);
    if (g) {
      const anim = this.animate(g, [{ transform: 'scale(1)', opacity: 1, filter: 'brightness(1)' }, { transform: 'scale(1.08)', opacity: 0, filter: 'brightness(2.4) blur(3px)' }], 0.5);
      this.done(anim, g, this.ms(0.6));
    }
    this.sparkle(el.rect, 'cast', 8);
  }

  /** A card that left: dies, is exiled, returns to hand, or vanishes (tokens). */
  leave(el: El, where: 'graveyard' | 'exile' | 'hand' | 'library' | 'gone' | 'discard', pile: DOMRect | null, pileNode: HTMLElement | null) {
    const g = this.ghost('fx-card', el.rect, el);
    if (!g) return;
    let frames: Keyframe[];
    let seconds = 0.8;
    const toPile = pile ? { x: pile.left + pile.width / 2 - (el.rect.left + el.rect.width / 2), y: pile.top + pile.height / 2 - (el.rect.top + el.rect.height / 2) } : null;
    switch (where) {
      case 'graveyard':
      case 'discard':
        frames = [
          { transform: 'none', filter: 'none', opacity: 1 },
          { transform: 'translateY(4px) rotate(-4deg) scale(0.98)', filter: 'grayscale(1) brightness(0.7) sepia(0.5) hue-rotate(-30deg) saturate(2)', opacity: 1, offset: 0.35 },
          toPile
            ? { transform: `translate(${toPile.x}px, ${toPile.y}px) rotate(-14deg) scale(0.25)`, filter: 'grayscale(1) brightness(0.4)', opacity: 0 }
            : { transform: 'translateY(30px) rotate(-10deg) scale(0.8)', filter: 'grayscale(1) brightness(0.3)', opacity: 0 },
        ];
        this.later(0.05, () => this.sparkle(el.rect, 'damage', 10));
        seconds = 0.9;
        break;
      case 'exile':
        frames = [
          { transform: 'none', filter: 'none', opacity: 1 },
          { transform: 'scale(1.08)', filter: 'brightness(2.5) saturate(0.2) blur(1px)', opacity: 1, offset: 0.4 },
          { transform: 'translateY(-30px) scale(1.25)', filter: 'brightness(4) blur(8px)', opacity: 0 },
        ];
        this.sparkle(el.rect, 'exile', 12);
        break;
      case 'hand':
      case 'library':
        frames = [
          { transform: 'none', opacity: 1 },
          toPile ? { transform: `translate(${toPile.x}px, ${toPile.y}px) scale(0.3)`, opacity: 0 } : { transform: 'translateY(-40px) scale(0.5)', opacity: 0 },
        ];
        seconds = 0.6;
        break;
      default:
        frames = [
          { transform: 'none', opacity: 1, filter: 'none' },
          { transform: 'scale(0.6)', opacity: 0, filter: 'brightness(2) blur(4px)' },
        ];
        this.sparkle(el.rect, 'token', 8);
        seconds = 0.5;
    }
    const anim = this.animate(g, frames, seconds, { easing: where === 'graveyard' ? EASE_IN : EASE_OUT });
    this.done(anim, g, this.ms(seconds + 0.1));
    if (pileNode) this.later(seconds * 0.8, () => this.pop(pileNode, 'land'));
  }

  /** Card backs sliding from a library to a hand (opponents' draws). */
  cardBack(from: DOMRect, to: DOMRect, n: number) {
    for (let i = 0; i < n; i++) {
      const div = this.ghost('fx-back', { left: from.left + from.width / 2 - 12, top: from.top + from.height / 2 - 17, width: 24, height: 34 });
      if (!div) return;
      const dx = to.left + to.width / 2 - (from.left + from.width / 2);
      const dy = to.top + to.height / 2 - (from.top + from.height / 2);
      const anim = this.animate(
        div,
        [
          { transform: 'translate(0, 0) scale(0.8)', opacity: 0 },
          { transform: `translate(${dx * 0.5}px, ${dy * 0.5 - 18}px) scale(1.1)`, opacity: 1, offset: 0.5 },
          { transform: `translate(${dx}px, ${dy}px) scale(0.7)`, opacity: 0 },
        ],
        0.5,
        { delay: this.ms(i * 0.12) },
      );
      this.done(anim, div, this.ms(0.8));
    }
  }

  /** A player knocked out of the game. */
  eliminated(mat: HTMLElement) {
    this.animate(mat, [{ filter: 'none', transform: 'none' }, { filter: 'grayscale(1) brightness(1.6)', transform: 'scale(1.02)', offset: 0.2 }, { filter: 'grayscale(1)', transform: 'none' }], 1);
    const r = mat.getBoundingClientRect();
    const div = this.ghost('fx-stamp', { left: r.left + r.width / 2, top: r.top + r.height / 2, width: 0, height: 0 });
    if (!div) return;
    div.textContent = 'Eliminated';
    const anim = this.animate(
      div,
      [
        { transform: 'translate(-50%, -50%) scale(2.4) rotate(-12deg)', opacity: 0 },
        { transform: 'translate(-50%, -50%) scale(1) rotate(-12deg)', opacity: 1, offset: 0.25 },
        { transform: 'translate(-50%, -50%) scale(1) rotate(-12deg)', opacity: 1, offset: 0.8 },
        { transform: 'translate(-50%, -50%) scale(1) rotate(-12deg)', opacity: 0 },
      ],
      1.6,
    );
    this.done(anim, div, this.ms(1.7));
  }

  /** A red edge around the screen when you take damage. */
  vignette(tone: Tone) {
    const div = this.ghost(`fx-vignette ${tone}`, { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight });
    if (!div) return;
    const anim = this.animate(div, [{ opacity: 0 }, { opacity: 1, offset: 0.2 }, { opacity: 0 }], 0.7);
    this.done(anim, div, this.ms(0.8));
  }

  /** A banner across the table: whose turn it is, or how the game ended. */
  banner(title: string, sub: string, tone: 'mine' | 'theirs' | 'win' | 'lose', seconds: number) {
    const r = this.root.getBoundingClientRect();
    const top = Math.max(80, Math.min(window.innerHeight / 2, r.top + r.height / 2)) - 50;
    overlay().querySelectorAll('.fx-banner').forEach((old) => old.remove());
    const div = this.ghost(`fx-banner ${tone}`, { left: 0, top, width: window.innerWidth, height: 100 });
    if (!div) return;
    div.innerHTML = '';
    const t = document.createElement('strong');
    t.textContent = title;
    const s = document.createElement('span');
    s.textContent = sub;
    div.append(t, s);
    const anim = this.animate(
      div,
      [
        { transform: 'translateX(-30%) scaleY(0.2)', opacity: 0 },
        { transform: 'translateX(0) scaleY(1)', opacity: 1, offset: 0.18 },
        { transform: 'translateX(2%) scaleY(1)', opacity: 1, offset: 0.8 },
        { transform: 'translateX(30%) scaleY(0.6)', opacity: 0 },
      ],
      seconds,
      { easing: 'ease-in-out' },
    );
    this.done(anim, div, this.ms(seconds + 0.1));
  }
}

const TONES: Record<Tone, string> = {
  enter: 'rgba(255, 230, 150, 0.85)',
  token: 'rgba(190, 255, 230, 0.85)',
  exile: 'rgba(235, 245, 255, 0.95)',
  cast: 'rgba(150, 200, 255, 0.9)',
  trigger: 'rgba(255, 200, 80, 0.9)',
  damage: 'rgba(255, 80, 60, 0.9)',
  heal: 'rgba(120, 240, 140, 0.9)',
  counter: 'rgba(120, 240, 140, 0.9)',
  pump: 'rgba(255, 220, 120, 0.9)',
  poison: 'rgba(170, 255, 90, 0.9)',
  land: 'rgba(200, 180, 255, 0.85)',
  hurt: 'rgba(255, 80, 60, 0.9)',
};
