// The last rules-bending cards in Zach's decks (cardRulesFinal.ts) and the engine pieces they needed:
// a mana pool that empties (rule 106.4), Horizon Stone, Thran Turbine, Solemnity, type-adding statics,
// Kill Switch, Despotic Scepter, Curse of Echoes, Reconnaissance, The Ozolith, Knowledge Pool, Nest of Scarabs.

import { describe, expect, it } from 'vitest';
import { Bot } from '../src/rules/bot';
import { card, creature, forest, spell } from './helpers';
import { attackAll, castOnce, find, Table } from './table';

const log = (t: Table, re: RegExp) => t.game.log!.filter((l) => re.test(l));
const artifact = (name: string, cost: string, cmc: number, text: string, extra: Record<string, unknown> = {}) => card({ name, manaCost: cost, cmc, types: ['Artifact'], text, ...extra });
const enchantment = (name: string, cost: string, cmc: number, text: string) => card({ name, manaCost: cost, cmc, types: ['Enchantment'], text, colorIdentity: ['W'] });
const ritual = () => spell('Dark Ritual', '{G}', 1, 'Instant', 'Add {B}{B}{B}.');

describe('the mana pool (rule 106.4)', () => {
  it('ritual mana empties as the step ends; Horizon Stone keeps it as colorless', () => {
    for (const stone of [false, true]) {
      const t = new Table();
      t.lands(0, 1);
      const p0 = t.game.players[0];
      if (stone) t.game.put(0, artifact('Horizon Stone', '{5}', 5, 'If you would lose unspent mana, that mana becomes colorless instead.'));
      p0.hand.push(ritual());
      t.handlers[0] = castOnce('Dark Ritual');
      t.until((g) => g.step === 'main2');
      const pool = t.game.livePool(p0).reduce((n, m) => n + m.n, 0);
      expect(pool).toBe(stone ? 3 : 0);
      if (stone) expect(t.game.livePool(p0)[0].colors).toEqual(['C']);
      expect(p0.treasures).toBe(0);
    }
  });

  it('Thran Turbine: {C}{C} in the upkeep pays for an ability, not a spell', () => {
    const turbine = artifact('Thran Turbine', '{1}', 1, "At the beginning of your upkeep, you may add {C}{C}. This mana can't be spent to cast spells.");
    expect(turbine.effects).toEqual([expect.objectContaining({ kind: 'treasure', abilityOnly: true, when: 'upkeep' })]);
    const t = new Table();
    const p0 = t.game.players[0];
    t.game.put(0, turbine);
    const engine = t.game.put(0, artifact('Mind Stone Engine', '{2}', 2, '{2}: Draw a card.'));
    p0.hand.push(creature('Grizzly Bears', '{2}', 2, 2, 2));
    let canCastBears = false;
    let used = false;
    t.handlers[0] = (g, d) => {
      if (d.kind !== 'priority' || g.step !== 'upkeep' || g.activeSeat !== 0) return undefined;
      if (find(d.actions, 'cast', 'Grizzly Bears') !== -1) canCastBears = true;
      const i = d.actions.findIndex((a) => a.type === 'activate' && a.permId === engine.id);
      if (i === -1 || used) return undefined;
      used = true;
      return { action: i };
    };
    t.finishTurn();
    t.until((g) => g.activeSeat === 0 && g.step === 'main1');
    expect(used).toBe(true);
    expect(canCastBears).toBe(false);
    expect(log(t, /draws 1 card/).length).toBeGreaterThan(0);
  });
});

describe('Solemnity', () => {
  it('stops +1/+1 counters on creatures and poison counters on players', () => {
    const t = new Table();
    const [p0, p1] = t.game.players;
    t.game.put(0, enchantment('Solemnity', '{2}{W}', 3, "Players can't get counters.\nCounters can't be put on artifacts, creatures, enchantments, or lands."));
    const bear = t.game.put(1, creature('Grizzly Bears', '{1}{G}', 2, 2, 2));
    t.game.putCounters(bear, 2);
    expect(bear.counters).toBe(0);
    t.lands(0, 1);
    p0.hand.push(spell('Virus Beetle', '{G}', 1, 'Sorcery', 'Each opponent gets a poison counter.'));
    t.handlers[0] = castOnce('Virus Beetle');
    t.finishTurn();
    expect(p1.poison).toBe(0);
  });
});

describe('cards that add card types', () => {
  it('Enchanted Evening makes every permanent an enchantment, until it leaves', () => {
    const t = new Table();
    const evening = t.game.put(0, card({ name: 'Enchanted Evening', manaCost: '{3}{W/U}{W/U}', cmc: 5, types: ['Enchantment'], text: 'All permanents are enchantments in addition to their other types.' }));
    const bear = t.game.put(1, creature('Grizzly Bears', '{1}{G}', 2, 2, 2));
    t.lands(0, 2);
    t.game.players[0].hand.push(spell('Erase', '{G}', 1, 'Instant', 'Exile target enchantment.'));
    t.handlers[0] = (g, d) => {
      if (d.kind === 'target' && d.candidates.some((c) => c.kind === 'perm' && c.id === bear.id)) return { kind: 'perm', id: bear.id };
      return castOnce('Erase')(g, d);
    };
    t.until((g) => g.stack.length === 0 && g.players[0].graveyard.some((c) => c.name === 'Erase'));
    expect(bear.card.isEnchantment).toBe(true);
    expect(t.game.players[1].battlefield.includes(bear)).toBe(false);
    void evening;
  });

  it('Encroaching Mycosynth: your creature spells set off "whenever you cast an artifact spell"', () => {
    const t = new Table();
    t.game.put(0, card({ name: 'Encroaching Mycosynth', manaCost: '{3}{U}', cmc: 4, types: ['Artifact'], text: 'Nonland permanents you control are artifacts in addition to their other types. The same is true for permanent spells you control and nonland permanent cards you own that aren\'t on the battlefield.' }));
    t.game.put(0, enchantment('Reckless Fireweaver', '{1}{R}', 2, 'Whenever you cast an artifact spell, you gain 1 life.'));
    t.lands(0, 2);
    const p0 = t.game.players[0];
    p0.hand.push(creature('Grizzly Bears', '{1}{G}', 2, 2, 2));
    const before = p0.life;
    t.handlers[0] = castOnce('Grizzly Bears');
    t.finishTurn();
    expect(p0.life).toBe(before + 1);
    expect(p0.battlefield.find((q) => q.card.name === 'Grizzly Bears')!.card.isArtifact).toBe(true);
  });
});

describe('Kill Switch', () => {
  it('taps every other artifact, and they miss their next untap step while it stays tapped', () => {
    const t = new Table();
    const sw = t.game.put(0, artifact('Kill Switch', '{3}', 3, '{2}, {T}: Tap all other artifacts. They don\'t untap during their controllers\' untap steps for as long as this artifact remains tapped.'));
    const rock = t.game.put(1, artifact('Mind Stone', '{2}', 2, '{T}: Add {C}.'));
    t.lands(0, 2);
    let used = false;
    t.handlers[0] = (_g, d) => {
      if (d.kind !== 'priority' || used) return undefined;
      const i = d.actions.findIndex((a) => a.type === 'activate' && a.permId === sw.id);
      if (i === -1) return undefined;
      used = true;
      return { action: i };
    };
    t.until(() => rock.tapped);
    t.until((g) => g.activeSeat === 1 && g.step === 'main1');
    expect(rock.tapped).toBe(true);
    // Back on seat 0's turn, Kill Switch untaps and lets go: the rock untaps in seat 1's following untap step.
    t.until((g) => g.activeSeat === 0 && g.step === 'main1');
    expect(sw.tapped).toBe(false);
    t.until((g) => g.activeSeat === 1 && g.step === 'main1');
    expect(rock.tapped).toBe(false);
  });
});

describe('Cybermen Squadron', () => {
  it('gives myriad to nonlegendary artifact creatures you control, not legendary ones', () => {
    const t = new Table();
    const squad = t.game.put(0, creature('Cybermen Squadron', '{7}', 7, 5, 5, { types: ['Artifact', 'Creature'], text: 'Nonlegendary artifact creatures you control have myriad.' }));
    const golem = t.game.put(0, creature('Iron Golem', '{3}', 3, 3, 3, { types: ['Artifact', 'Creature'] }));
    const legend = t.game.put(0, creature('Karn Golem', '{3}', 3, 3, 3, { types: ['Artifact', 'Creature'], superTypes: ['Legendary'] }));
    expect(t.game.hasKw(squad, 'myriad')).toBe(true);
    expect(t.game.hasKw(golem, 'myriad')).toBe(true);
    expect(t.game.hasKw(legend, 'myriad')).toBe(false);
  });
});

describe('Desecrated Tomb', () => {
  it('makes a Bat when a creature card leaves your graveyard', () => {
    const t = new Table();
    const p0 = t.game.players[0];
    t.game.put(0, artifact('Desecrated Tomb', '{3}', 3, 'Whenever one or more creature cards leave your graveyard, create a 1/1 black Bat creature token with flying.'));
    p0.graveyard.push(creature('Grizzly Bears', '{1}{G}', 2, 2, 2));
    t.lands(0, 1);
    p0.hand.push(spell('Raise Dead', '{G}', 1, 'Sorcery', 'Return target creature card from your graveyard to your hand.'));
    t.handlers[0] = castOnce('Raise Dead');
    t.finishTurn();
    expect(p0.battlefield.some((q) => /Bat/.test(q.card.name) || q.card.typeLine.includes('Bat'))).toBe(true);
  });
});

describe('Despotic Scepter', () => {
  it('destroys a permanent you own that an opponent stole', () => {
    const t = new Table();
    const [p0] = t.game.players;
    const scepter = t.game.put(0, artifact('Despotic Scepter', '{1}', 1, '{T}: Destroy target permanent you own. It can\'t be regenerated.'));
    const stolen = t.game.put(1, creature('Craw Wurm', '{4}{G}{G}', 6, 6, 4));
    stolen.owner = 0;
    t.handlers[0] = (_g, d) => {
      if (d.kind !== 'priority') return undefined;
      const i = d.actions.findIndex((a) => a.type === 'activate' && a.permId === scepter.id);
      return i === -1 ? undefined : { action: i };
    };
    t.until(() => p0.graveyard.some((c) => c.name === 'Craw Wurm'));
    expect(t.game.players[1].battlefield.includes(stolen)).toBe(false);
  });

  it('a bot uses it on its own stolen permanent', () => {
    const t = new Table();
    const scepter = t.game.put(0, artifact('Despotic Scepter', '{1}', 1, '{T}: Destroy target permanent you own. It can\'t be regenerated.'));
    const stolen = t.game.put(1, creature('Craw Wurm', '{4}{G}{G}', 6, 6, 4));
    stolen.owner = 0;
    const bot = new Bot(0, 1);
    t.handlers[0] = (g, d) => bot.decide(g, d);
    t.finishTurn();
    expect(scepter.tapped || log(t, /destroyed \(Despotic/).length > 0).toBe(true);
    expect(t.game.players[0].graveyard.some((c) => c.name === 'Craw Wurm')).toBe(true);
  });
});

describe('Curse of Echoes', () => {
  it('reads as a Curse that lets each other player copy the enchanted player\'s instants and sorceries', () => {
    const curse = card({ name: 'Curse of Echoes', manaCost: '{4}{U}', cmc: 5, types: ['Enchantment'], subTypes: ['Aura', 'Curse'], text: 'Enchant player\nWhenever enchanted player casts an instant or sorcery spell, each other player may copy that spell and may choose new targets for the copy they control.' });
    expect(curse.curse).toEqual([expect.objectContaining({ on: 'casts', act: 'echoes', filter: 'instantSorcery' })]);
    expect(curse.unread).toBeUndefined();
  });

  it('the cursing player copies a draw spell the enchanted player casts', () => {
    const t = new Table(2);
    const [p0, p1] = t.game.players;
    const curse = card({ name: 'Curse of Echoes', manaCost: '{4}{U}', cmc: 5, types: ['Enchantment'], subTypes: ['Aura', 'Curse'], text: 'Enchant player\nWhenever enchanted player casts an instant or sorcery spell, each other player may copy that spell and may choose new targets for the copy they control.' });
    const perm = t.game.put(1, curse);
    perm.cursing = 0;
    (t.game as unknown as { anyCurse: boolean }).anyCurse = true;
    t.lands(0, 1);
    p0.hand.push(spell('Divination', '{G}', 1, 'Sorcery', 'Draw two cards.'));
    const before = p1.hand.length;
    t.handlers[0] = castOnce('Divination');
    t.until((g) => g.stack.length === 0 && p0.graveyard.some((c) => c.name === 'Divination'));
    expect(log(t, /p1 \(P2\) copies Divination/)).toHaveLength(1);
    expect(log(t, /p1 \(P2\) draws 2 cards/)).toHaveLength(1);
    void before;
  });
});

describe('Reconnaissance', () => {
  it('a bot pulls a blocked attacker that would die out of combat, untapped', () => {
    const t = new Table();
    t.game.put(0, enchantment('Reconnaissance', '{W}', 1, '{0}: Remove target attacking creature you control from combat and untap it.'));
    const bear = t.game.put(0, creature('Grizzly Bears', '{1}{G}', 2, 2, 2));
    const wurm = t.game.put(1, creature('Craw Wurm', '{4}{G}{G}', 6, 6, 4));
    bear.sick = false;
    const bot = new Bot(0, 1);
    t.handlers[0] = (g, d) => (d.kind === 'attackers' ? attackAll(1)(g, d) : bot.decide(g, d));
    t.handlers[1] = (_g, d) => (d.kind === 'blockers' ? [{ blocker: wurm.id, attacker: bear.id }] : undefined);
    t.finishTurn();
    expect(log(t, /removed from combat/).length).toBe(1);
    expect(t.game.players[0].battlefield.includes(bear)).toBe(true);
    expect(bear.tapped).toBe(false);
  });
});

describe('The Ozolith', () => {
  it('keeps the counters of a creature that leaves, and moves them at the beginning of combat', () => {
    const t = new Table();
    const oz = t.game.put(0, artifact('The Ozolith', '{1}', 1, 'Whenever a creature you control leaves the battlefield, if it had counters on it, put those counters on The Ozolith.\nAt the beginning of combat on your turn, if The Ozolith has counters on it, you may move all counters from The Ozolith onto target creature.', { superTypes: ['Legendary'] }));
    const big = t.game.put(0, creature('Grizzly Bears', '{1}{G}', 2, 2, 2));
    const keeper = t.game.put(0, creature('Craw Wurm', '{4}{G}{G}', 6, 6, 4));
    t.game.putCounters(big, 3);
    t.lands(0, 1);
    t.game.players[0].hand.push(spell('Unsummon', '{G}', 1, 'Instant', 'Return target creature to its owner\'s hand.'));
    t.handlers[0] = (g, d) => {
      if (d.kind === 'target' && d.effect?.kind === 'removal') return { kind: 'perm', id: big.id };
      if (d.kind === 'target' && d.effect?.kind === 'ozolith') return { kind: 'perm', id: keeper.id };
      return castOnce('Unsummon')(g, d);
    };
    t.until(() => oz.counters === 3);
    t.until((g) => g.step === 'declareAttackers' || g.turnNumber > 1);
    expect(keeper.counters).toBe(3);
    expect(oz.counters).toBe(0);
  });
});

describe('Knowledge Pool', () => {
  it('a spell cast from hand is exiled and swapped for a card in the pool', () => {
    const t = new Table();
    const [p0] = t.game.players;
    const pool = card({ name: 'Knowledge Pool', manaCost: '{6}', cmc: 6, types: ['Artifact'], text: 'Imprint — When this artifact enters, each player exiles the top three cards of their library.\nWhenever a player casts a spell from their hand, that player exiles it. If the player does, they may cast a spell from among other cards exiled with this artifact without paying its mana cost.' });
    t.lands(0, 8);
    for (const p of t.game.players) p.library.unshift(creature('Craw Wurm', '{4}{G}{G}', 6, 6, 4), forest(), forest());
    p0.hand.push(pool, creature('Grizzly Bears', '{1}{G}', 2, 2, 2));
    const cast = castOnce('Knowledge Pool');
    const bears = castOnce('Grizzly Bears', (g) => g.players[0].battlefield.some((q) => q.card.name === 'Knowledge Pool'));
    t.handlers[0] = (g, d) => {
      if (d.kind === 'choose' && d.reason === 'freeCast') return [d.options.findIndex((o) => o.label === 'Craw Wurm')];
      return cast(g, d) ?? bears(g, d);
    };
    t.finishTurn();
    expect(p0.exile.some((c) => c.name === 'Grizzly Bears')).toBe(true);
    expect(p0.battlefield.some((q) => q.card.name === 'Craw Wurm')).toBe(true);
  });
});

describe('Nest of Scarabs', () => {
  it('makes an Insect for each -1/-1 counter you put on a creature', () => {
    const t = new Table();
    const [p0] = t.game.players;
    t.game.put(0, enchantment('Nest of Scarabs', '{2}{B}', 3, 'Whenever you put one or more -1/-1 counters on a creature, create that many 1/1 black Insect creature tokens.'));
    t.game.put(1, creature('Craw Wurm', '{4}{G}{G}', 6, 6, 4));
    t.lands(0, 1);
    p0.hand.push(spell('Grim Affliction', '{G}', 1, 'Instant', 'Put two -1/-1 counters on target creature.'));
    t.handlers[0] = castOnce('Grim Affliction');
    t.finishTurn();
    expect(p0.battlefield.filter((q) => q.token && q.card.typeLine.includes('Insect'))).toHaveLength(2);
  });
});

describe('Alter Reality and Whim of Volrath', () => {
  it('turns an opponent\'s protection from our color into protection from a color we don\'t play', () => {
    const t = new Table();
    const [p0] = t.game.players;
    p0.identity = ['G'];
    const knight = t.game.put(1, creature('White Knight', '{W}{W}', 2, 2, 2, { text: 'First strike\nProtection from green' }));
    expect(knight.card.keywords).toContain('pro:G');
    t.lands(0, 2);
    p0.hand.push(card({ name: 'Alter Reality', manaCost: '{2}', cmc: 2, types: ['Instant'], text: 'Change the text of target spell or permanent by replacing all instances of one color word with another. (This effect lasts indefinitely.)\nFlashback {1}{U}' }));
    t.handlers[0] = (g, d) => (d.kind === 'target' && d.effect?.kind === 'textChange' ? { kind: 'perm', id: knight.id } : castOnce('Alter Reality')(g, d));
    t.finishTurn();
    expect(knight.card.keywords).not.toContain('pro:G');
    expect(knight.card.keywords.some((k) => k.startsWith('pro:'))).toBe(true);
  });
});
