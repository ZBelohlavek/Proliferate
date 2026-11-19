// The last Commander gaps: battles, the legend rule's choice, a commander headed for the library,
// and bots that block to save their planeswalkers.

import { describe, expect, it } from 'vitest';
import { Bot } from '../src/rules/bot';
import { refereeGame } from '../src/rules/legality';
import { card, creature, stompyDeck } from './helpers';
import { castOnce, Table } from './table';

const siege = () => card({
  name: 'Invasion of Testing', manaCost: '{3}{G}', cmc: 4, types: ['Battle'], subTypes: ['Siege'], layout: 'transform', defense: 4, colorIdentity: ['G'],
  text: "(As a Siege enters, choose an opponent to protect it. You and others can attack it. When it's defeated, exile it, then cast it transformed.)",
  back: { name: 'Test Faerie', types: ['Creature'], subTypes: ['Faerie'], text: 'Flying', power: '3', toughness: '3' },
});

const walker = (loyalty: number) => card({ name: 'Test Walker', manaCost: '{3}{G}', cmc: 4, types: ['Planeswalker'], loyalty, text: '+1: You gain 1 life.', colorIdentity: ['G'] });

describe('battles (rule 310)', () => {
  it('a Siege enters with defense counters and a protector its controller chooses', () => {
    const t = new Table(3);
    const s = siege();
    expect(s.isBattle).toBe(true);
    expect(s.defense).toBe(4);
    t.game.players[0].hand.push(s);
    t.lands(0, 4);
    let asked = false;
    const cast = castOnce(s.name);
    t.handlers[0] = (g, d) => {
      if (d.kind === 'choose' && d.reason === 'protector') {
        asked = true;
        return [1];
      }
      return cast(g, d);
    };
    t.finishTurn();
    const perm = t.game.players[0].battlefield.find((q) => q.card === s)!;
    expect(asked).toBe(true);
    expect(perm.defense).toBe(4);
    expect(perm.protector).toBe(2);
  });

  it('its controller attacks it; the protector defends; defeated, it is cast transformed (rules 506.2, 310.11b)', () => {
    const t = new Table(3);
    const [a] = t.game.players;
    const s = siege();
    const battle = t.game.put(0, s);
    battle.defense = 4;
    battle.protector = 1;
    const wurm = t.game.put(0, creature('Wurm', '{4}{G}', 5, 5, 5));
    t.game.put(1, creature('Squirrel', '{G}', 1, 1, 1));
    let offered: number[] | undefined;
    let blockerSeat: number | undefined;
    t.handlers[0] = (_g, d) => {
      if (d.kind !== 'attackers') return undefined;
      offered = d.planeswalkers;
      return [{ attacker: wurm.id, defender: 2, planeswalker: battle.id }];
    };
    t.handlers[1] = (_g, d) => {
      if (d.kind === 'blockers') blockerSeat = d.seat;
      return undefined;
    };
    t.finishTurn();
    expect(offered).toContain(battle.id);
    // The protector was the defending player, whatever seat the declaration named.
    expect(blockerSeat).toBe(1);
    expect(t.game.findPerm(battle.id)).toBeNull();
    const faerie = a.battlefield.find((q) => q.card.name === 'Test Faerie');
    expect(faerie).toBeDefined();
    expect(a.exile).not.toContain(s);
    expect(t.game.players[1].life).toBe(40);
  });

  it("the protector can't attack the battle it protects", () => {
    const t = new Table();
    const battle = t.game.put(1, siege());
    battle.defense = 4;
    battle.protector = 0;
    t.game.put(0, creature('Wurm', '{4}{G}', 5, 5, 5));
    let offered: number[] | undefined = [];
    t.handlers[0] = (_g, d) => {
      if (d.kind === 'attackers') offered = d.planeswalkers;
      return undefined;
    };
    t.finishTurn();
    expect(offered ?? []).not.toContain(battle.id);
  });

  it('a bot sends a creature its protector cannot block at its own battle', () => {
    const t = new Table();
    const battle = t.game.put(0, siege());
    battle.defense = 3;
    battle.protector = 1;
    t.game.put(0, creature('Bird', '{1}{G}', 2, 3, 3, { keywords: ['Flying'], text: 'Flying' }));
    const bot = new Bot(0, 1);
    t.handlers[0] = (g, d) => (d.kind === 'attackers' ? bot.decide(g, d) : undefined);
    t.finishTurn();
    expect(t.game.findPerm(battle.id)).toBeNull();
    expect(t.game.players[0].battlefield.some((q) => q.card.name === 'Test Faerie')).toBe(true);
  });

  it('a battle whose protector leaves the game goes to the graveyard (rule 704.5w)', () => {
    const t = new Table(3);
    const s = siege();
    const battle = t.game.put(0, s);
    battle.defense = 4;
    battle.protector = 1;
    t.game.players[1].life = 0;
    t.finishTurn();
    expect(t.game.findPerm(battle.id)).toBeNull();
    expect(t.game.players[0].graveyard).toContain(s);
  });
});

describe('the legend rule (704.5j)', () => {
  it('its controller chooses which one to keep', () => {
    const t = new Table();
    const [a] = t.game.players;
    const legend = creature('Legendary Bear', '{1}{G}', 2, 2, 2, { superTypes: ['Legendary'] });
    const first = t.game.put(0, legend);
    const second = t.game.put(0, legend, { counters: 2 });
    let options = 0;
    t.handlers[0] = (_g, d) => {
      if (d.kind === 'choose' && d.reason === 'legend') {
        options = d.options.length;
        return [d.options.findIndex((o) => o.permId === second.id)];
      }
      return undefined;
    };
    t.finishTurn();
    expect(options).toBe(2);
    expect(t.game.findPerm(first.id)).toBeNull();
    expect(t.game.findPerm(second.id)).not.toBeNull();
    expect(a.graveyard).toContain(legend);
  });

  it('a bot keeps its commander over a copy', () => {
    const t = new Table();
    const legend = creature('Legendary Bear', '{1}{G}', 2, 2, 2, { superTypes: ['Legendary'] });
    const copy = t.game.put(0, legend, { counters: 1 });
    const cmd = t.game.put(0, legend, { commander: true });
    const bot = new Bot(0, 1);
    t.handlers[0] = (g, d) => (d.kind === 'choose' && d.reason === 'legend' ? bot.decide(g, d) : undefined);
    t.finishTurn();
    expect(t.game.findPerm(cmd.id)).not.toBeNull();
    expect(t.game.findPerm(copy.id)).toBeNull();
  });
});

describe('a commander headed for its library (rule 903.9b)', () => {
  for (const answer of [true, false]) {
    it(`its owner is asked, and ${answer ? 'it goes to the command zone' : 'it can stay in the library'}`, () => {
      const t = new Table();
      const [a] = t.game.players;
      const cmd = a.deck.commanders[0];
      a.commandZone = a.commandZone.filter((c) => c !== cmd);
      const perm = t.game.put(0, cmd, { commander: true });
      let to: string | undefined;
      t.handlers[0] = (_g, d) => {
        if (d.kind === 'confirm' && d.reason === 'commandZone') {
          to = d.to;
          return answer;
        }
        return undefined;
      };
      (t.game as any).removePerms([perm], 'library');
      t.finishTurn();
      expect(to).toBe('library');
      expect(a.commandZone.includes(cmd)).toBe(answer);
      expect(a.library.includes(cmd)).toBe(!answer);
    });
  }
});

describe('bots protect their planeswalkers', () => {
  it('chump-blocks an attacker that would finish one', () => {
    const t = new Table();
    const pw = t.game.put(1, walker(3));
    const chump = t.game.put(1, creature('Squirrel', '{G}', 1, 1, 1));
    const wurm = t.game.put(0, creature('Wurm', '{4}{G}', 5, 5, 5));
    t.handlers[0] = (_g, d) => (d.kind === 'attackers' ? [{ attacker: wurm.id, defender: 1, planeswalker: pw.id }] : undefined);
    const bot = new Bot(1, 1);
    t.handlers[1] = (g, d) => (d.kind === 'blockers' ? bot.decide(g, d) : undefined);
    t.finishTurn();
    expect(t.game.findPerm(pw.id)?.loyalty).toBe(3);
    expect(t.game.findPerm(chump.id)).toBeNull();
  });

  it("doesn't throw a creature away when the planeswalker survives anyway", () => {
    const t = new Table();
    const pw = t.game.put(1, walker(6));
    const chump = t.game.put(1, creature('Squirrel', '{G}', 1, 1, 1));
    const bear = t.game.put(0, creature('Bear', '{1}{G}', 2, 3, 3));
    t.handlers[0] = (_g, d) => (d.kind === 'attackers' ? [{ attacker: bear.id, defender: 1, planeswalker: pw.id }] : undefined);
    const bot = new Bot(1, 1);
    t.handlers[1] = (g, d) => (d.kind === 'blockers' ? bot.decide(g, d) : undefined);
    t.finishTurn();
    expect(t.game.findPerm(pw.id)?.loyalty).toBe(3);
    expect(t.game.findPerm(chump.id)).not.toBeNull();
  });
});

describe('the referee with battles in the decks', () => {
  it('finds nothing illegal when every deck runs Sieges', () => {
    const problems: string[] = [];
    let attacks = 0;
    for (let seed = 1; seed <= 6; seed++) {
      const decks = [0, 1, 2, 3].map((i) => {
        const d = stompyDeck(`b${i}`);
        // Ten of the Grizzly Bears are Sieges instead.
        d.cards = d.cards.map((c) => (c.card.name === 'Grizzly Bears' ? { ...c, count: c.count - 10 } : c));
        d.cards.push({ card: siege(), count: 10 });
        return d;
      });
      const { referee, game } = refereeGame(decks, seed, { log: true });
      problems.push(...referee.violations.map((v) => `seed ${seed} ${v.rule}: ${v.msg}`));
      attacks += (game.log ?? []).filter((l) => /attacks Invasion of Testing/.test(l)).length;
    }
    expect(problems).toEqual([]);
    expect(attacks).toBeGreaterThan(0);
  }, 60_000);
});
