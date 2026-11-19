// Gaining control, token copies and becoming a copy, token replacement, and changing targets:
// the card reader, the rules engine and the bots. Cards use their real oracle text, with green
// mana costs where the test table needs them.

import { describe, expect, it } from 'vitest';
import { Bot } from '../src/rules/bot';
import type { Game } from '../src/rules/game';
import type { Decision } from '../src/rules/types';
import { creature, spell } from './helpers';
import { castOnce, find, Table } from './table';

const log = (t: Table, re: RegExp) => t.game.log!.filter((l) => re.test(l));

const kiki = () => creature('Kiki-Jiki, Mirror Breaker', '{2}{G}{G}{G}', 5, 2, 2, {
  superTypes: ['Legendary'], keywords: ['Haste'],
  text: "Haste\n{T}: Create a token that's a copy of target nonlegendary creature you control, except it has haste. Sacrifice it at the beginning of the next end step.",
});
const actOfTreason = () => spell('Act of Treason', '{2}{G}', 3, 'Sorcery', 'Gain control of target creature until end of turn. Untap that creature. It gains haste until end of turn. (It can attack and {T} this turn.)');
const swat = () => spell('Deflecting Swat', '{2}{G}', 3, 'Instant', 'If you control a commander, you may cast this spell without paying its mana cost.\nYou may choose new targets for target spell or ability.');
const murder = () => spell('Murder', '{1}{G}', 2, 'Instant', 'Destroy target creature.');
const spellskite = () => creature('Spellskite', '{2}', 2, 0, 4, { types: ['Artifact', 'Creature'], text: '{U/P}: Change a target of target spell or ability to this creature. ({U/P} can be paid with either {U} or 2 life.)' });
const manufactor = () => creature('Academy Manufactor', '{3}', 3, 1, 3, { types: ['Artifact', 'Creature'], text: 'If you would create a Clue, Food, or Treasure token, instead create one of each.' });
const urge = () => spell('Treacherous Urge', '{4}{G}', 5, 'Instant', 'Target opponent reveals their hand. You may put a creature card from it onto the battlefield under your control. That creature gains haste. Sacrifice it at the beginning of the next end step.');
const bears = () => creature('Grizzly Bears', '{1}{G}', 2, 2, 2);
const wurm = () => creature('Craw Wurm', '{4}{G}{G}', 6, 6, 4);

const botSeat = (t: Table, seat: number) => {
  t.game.players[seat].commandZone = [];
  const bot = new Bot(seat, 1);
  t.handlers[seat] = (g: Game, d: Decision) => bot.decide(g, d);
};

describe('the card reader', () => {
  it('reads Kiki-Jiki, Act of Treason, Deflecting Swat, Spellskite and Academy Manufactor as real rules', () => {
    expect(kiki().effects[0]).toMatchObject({ kind: 'tokenCopy', of: 'target', haste: true, end: 'sacrifice', filter: { yours: true, nonlegendary: true } });
    expect(actOfTreason().effects[0]).toMatchObject({ kind: 'steal', until: 'eot', untap: true, haste: true });
    expect(swat().effects.some((e) => e.kind === 'redirect' && e.to === 'choose')).toBe(true);
    expect(spellskite().effects[0]).toMatchObject({ kind: 'redirect', to: 'self', when: 'activated' });
    expect(manufactor().effects[0]).toMatchObject({ kind: 'tokenReplace', add: 'oneOfEach' });
    expect(urge().effects[0]).toMatchObject({ kind: 'steal', from: 'hand', sacAtEnd: true });
    for (const c of [kiki(), actOfTreason(), swat(), spellskite(), manufactor(), urge()]) expect(c.unread ?? []).toEqual([]);
  });
});

describe('gaining control (rule 613.1b)', () => {
  it('Act of Treason takes a creature untapped with haste, and it goes back at end of turn', () => {
    const t = new Table();
    const [a, b] = t.game.players;
    t.lands(0, 3);
    const theirs = t.game.put(1, wurm());
    theirs.tapped = true;
    a.hand.push(actOfTreason());
    t.handlers[0] = castOnce('Act of Treason');
    t.until(() => a.battlefield.includes(theirs));
    expect(theirs.tapped).toBe(false);
    expect(t.game.hasKw(theirs, 'haste')).toBe(true);
    expect(theirs.borrowed?.until).toBe('eot');
    t.finishTurn();
    expect(b.battlefield.includes(theirs)).toBe(true);
    expect(a.battlefield.includes(theirs)).toBe(false);
  });

  it('a bot sacrifices what it only borrowed first', () => {
    const t = new Table();
    const mine = t.game.put(0, bears());
    const theirs = t.game.put(0, wurm());
    theirs.owner = 1;
    theirs.borrowed = { until: 'eot', by: 0, turn: t.game.turnNumber };
    const bot = new Bot(0, 1);
    const pick = bot.decide(t.game, { kind: 'choose', seat: 0, reason: 'sacrifice', prompt: 'Sacrifice a creature', options: [mine, theirs].map((q) => ({ label: q.card.name, permId: q.id })), min: 1, max: 1 });
    expect(pick).toEqual([1]);
  });

  it('Treacherous Urge puts the best creature from their hand onto our battlefield, sacrificed at the end step', () => {
    const t = new Table();
    const [a, b] = t.game.players;
    t.lands(0, 5);
    b.hand.push(wurm(), bears());
    a.hand.push(urge());
    const cast = castOnce('Treacherous Urge');
    t.handlers[0] = (g, d) => (d.kind === 'choose' ? [d.options.findIndex((o) => o.card?.name === 'Craw Wurm')] : cast(g, d));
    t.until(() => a.battlefield.some((q) => q.card.name === 'Craw Wurm'));
    expect(b.hand.map((c) => c.name)).toEqual(['Grizzly Bears']);
    t.finishTurn();
    expect(a.battlefield.some((q) => q.card.name === 'Craw Wurm')).toBe(false);
    expect(b.graveyard.some((c) => c.name === 'Craw Wurm')).toBe(true);
  });
});

describe('token copies (rule 707.2)', () => {
  it('Kiki-Jiki copies a nonlegendary creature with haste and sacrifices the copy at the end step', () => {
    const t = new Table();
    const [a] = t.game.players;
    t.game.put(0, kiki());
    t.game.put(0, wurm());
    t.handlers[0] = (g, d) => {
      if (d.kind !== 'priority' || g.step !== 'main1') return undefined;
      const i = d.actions.findIndex((x) => x.type === 'activate' && x.effect.kind === 'tokenCopy');
      return i === -1 ? undefined : { action: i };
    };
    t.until(() => a.battlefield.filter((q) => q.card.name === 'Craw Wurm').length === 2);
    const copy = a.battlefield.find((q) => q.card.name === 'Craw Wurm' && q.token)!;
    expect(copy).toBeDefined();
    expect(t.game.hasKw(copy, 'haste')).toBe(true);
    t.finishTurn();
    expect(a.battlefield.filter((q) => q.card.name === 'Craw Wurm')).toHaveLength(1);
  });

  it('a bot uses Kiki-Jiki before combat', () => {
    const t = new Table();
    const [a] = t.game.players;
    t.game.put(0, kiki());
    t.game.put(0, wurm());
    botSeat(t, 0);
    t.until((g) => g.turnNumber > 1 || a.battlefield.some((q) => q.token));
    expect(a.battlefield.some((q) => q.token && q.card.name === 'Craw Wurm')).toBe(true);
  });
});

describe('token replacement (rule 614.1)', () => {
  it('Academy Manufactor turns one Treasure into a Clue, a Food and a Treasure', () => {
    const t = new Table();
    const [a] = t.game.players;
    t.lands(0, 1);
    t.game.put(0, manufactor());
    a.hand.push(spell('Strike It Rich', '{G}', 1, 'Sorcery', 'Create a Treasure token.'));
    t.handlers[0] = castOnce('Strike It Rich');
    t.until(() => a.graveyard.some((c) => c.name === 'Strike It Rich'));
    const names = a.battlefield.filter((q) => q.token).map((q) => q.card.name).sort();
    // Treasures are kept as a count rather than as permanents.
    expect(names).toEqual(['Clue', 'Food']);
    expect(a.treasures).toBe(1);
  });
});

describe('changing targets (rule 115.7)', () => {
  it("Deflecting Swat sends an opponent's Murder at their own creature", () => {
    const t = new Table();
    const [a, b] = t.game.players;
    t.lands(0, 3);
    t.lands(1, 2);
    const mine = t.game.put(0, wurm());
    const theirs = t.game.put(1, bears());
    b.hand.push(murder());
    a.hand.push(swat());
    t.handlers[1] = castOnce('Murder');
    t.handlers[0] = (g, d) => {
      if (d.kind === 'priority' && g.stack.length === 1 && g.stack[0].controller === 1) {
        const i = find(d.actions, 'cast', 'Deflecting Swat');
        return i === -1 ? undefined : { action: i };
      }
      if (d.kind === 'target' && d.effect?.kind === 'removal') return d.candidates.find((c) => c.kind === 'perm' && c.id === theirs.id);
      return undefined;
    };
    t.until(() => b.graveyard.some((c) => c.name === 'Murder'));
    expect(a.battlefield.includes(mine)).toBe(true);
    expect(b.battlefield.includes(theirs)).toBe(false);
    expect(log(t, /changes the target of Murder/)).toHaveLength(1);
  });

  it("a bot uses Deflecting Swat on removal aimed at its best creature", () => {
    const t = new Table();
    const [a, b] = t.game.players;
    t.lands(0, 3);
    t.lands(1, 2);
    const mine = t.game.put(0, wurm());
    const theirs = t.game.put(1, bears());
    b.hand.push(murder());
    a.hand.push(swat());
    t.handlers[1] = castOnce('Murder');
    botSeat(t, 0);
    t.until(() => b.graveyard.some((c) => c.name === 'Murder'));
    expect(a.battlefield.includes(mine)).toBe(true);
    expect(b.battlefield.includes(theirs)).toBe(false);
  });

  it('Spellskite pulls the removal onto itself', () => {
    const t = new Table();
    const [a, b] = t.game.players;
    t.lands(1, 2);
    const mine = t.game.put(0, wurm());
    const skite = t.game.put(0, spellskite());
    b.hand.push(murder());
    t.handlers[1] = castOnce('Murder');
    botSeat(t, 0);
    t.until(() => b.graveyard.some((c) => c.name === 'Murder'));
    expect(a.battlefield.includes(mine)).toBe(true);
    expect(a.battlefield.includes(skite)).toBe(false);
  });
});

describe('becoming a copy and copying spells (rules 707.10, 707.12)', () => {
  const mirror = () => spell('Mirage Mirror', '{3}', 3, 'Artifact', '{2}: This artifact becomes a copy of target artifact, creature, enchantment, or land until end of turn.');
  const doubleMajor = () => spell('Double Major', '{G}{G}', 2, 'Instant', "Copy target creature spell you control, except it isn't legendary if the spell is legendary. (A copy of a creature spell becomes a token.)");

  it('Mirage Mirror becomes a copy of a creature until end of turn, then is itself again', () => {
    const t = new Table();
    const [a] = t.game.players;
    t.lands(0, 2);
    const m = t.game.put(0, mirror());
    t.game.put(1, wurm());
    t.handlers[0] = (g, d) => {
      if (d.kind !== 'priority' || g.step !== 'main1' || m.card.name !== 'Mirage Mirror') return undefined;
      const i = d.actions.findIndex((x) => x.type === 'activate' && x.effect.kind === 'becomeCopy');
      return i === -1 ? undefined : { action: i };
    };
    t.until(() => m.card.name === 'Craw Wurm');
    expect(t.game.power(m)).toBe(6);
    t.finishTurn();
    expect(a.battlefield.includes(m)).toBe(true);
    expect(m.card.name).toBe('Mirage Mirror');
  });

  it('Double Major copies a creature spell as a token', () => {
    const t = new Table();
    const [a] = t.game.players;
    t.lands(0, 8);
    a.hand.push(wurm(), doubleMajor());
    const castWurm = castOnce('Craw Wurm');
    const castCopy = castOnce('Double Major', (g) => g.stack.some((s) => s.card.name === 'Craw Wurm'));
    t.handlers[0] = (g, d) => castCopy(g, d) ?? castWurm(g, d);
    t.until(() => a.battlefield.filter((q) => q.card.name === 'Craw Wurm').length === 2);
    expect(a.battlefield.filter((q) => q.card.name === 'Craw Wurm' && q.token)).toHaveLength(1);
  });
});

describe('taking cards that leave the battlefield', () => {
  const tergrid = () => creature('Tergrid, God of Fright', '{3}{G}{G}', 5, 4, 5, { superTypes: ['Legendary'], text: 'Menace\nWhenever an opponent sacrifices a nontoken permanent or discards a permanent card, you may put that card from a graveyard onto the battlefield under your control.' });
  const edict = () => spell('Diabolic Edict', '{1}{G}', 2, 'Instant', 'Target player sacrifices a creature.');
  const minionsReturn = () => spell('Minion\'s Return', '{2}{G}', 3, 'Enchantment', 'Flash\nEnchant creature\nWhen enchanted creature dies, return that card to the battlefield under your control.', { subTypes: ['Aura'] });

  it('Tergrid takes the creature an opponent sacrifices', () => {
    const t = new Table();
    const [a, b] = t.game.players;
    t.lands(0, 2);
    t.game.put(0, tergrid());
    t.game.put(1, wurm());
    a.hand.push(edict());
    const cast = castOnce('Diabolic Edict');
    t.handlers[0] = (g, d) => (d.kind === 'target' && d.candidates.some((c) => c.kind === 'player') ? { kind: 'player', seat: 1 } : d.kind === 'choose' ? [0] : cast(g, d));
    t.until(() => a.battlefield.some((q) => q.card.name === 'Craw Wurm'));
    expect(b.battlefield.some((q) => q.card.name === 'Craw Wurm')).toBe(false);
    expect(a.battlefield.find((q) => q.card.name === 'Craw Wurm')!.owner).toBe(1);
  });

  it("Minion's Return brings the enchanted creature back under our control when it dies", () => {
    const t = new Table();
    const [a, b] = t.game.players;
    t.lands(0, 5);
    const theirs = t.game.put(1, wurm());
    a.hand.push(minionsReturn(), murder());
    const aura = castOnce("Minion's Return");
    const kill = castOnce('Murder', (g) => g.allPerms().some((q) => q.card.name === "Minion's Return"));
    t.handlers[0] = (g, d) => (d.kind === 'target' ? d.candidates.find((c) => c.kind === 'perm' && c.id === theirs.id) ?? d.candidates[0] : kill(g, d) ?? aura(g, d));
    t.until(() => a.battlefield.some((q) => q.card.name === 'Craw Wurm'));
    expect(b.battlefield.some((q) => q.card.name === 'Craw Wurm')).toBe(false);
  });
});
