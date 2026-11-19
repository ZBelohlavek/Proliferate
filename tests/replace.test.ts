// Replacement and prevention effects (rules 614, 615), regeneration (701.19), death and
// leave-the-battlefield replacements, trigger doublers (603.2d) and "whenever an opponent ..."
// triggers: the card reader and the rules engine. Cards use their real oracle text.

import { describe, expect, it } from 'vitest';
import type { Effect } from '../src/engine/types';
import type { Perm, PlayerState } from '../src/rules/types';
import { creature, spell } from './helpers';
import { attackAll, castOnce, Table } from './table';

const log = (t: Table, re: RegExp) => t.game.log!.filter((l) => re.test(l));
const effect = <K extends Effect['kind']>(c: { effects: Effect[] }, kind: K) => c.effects.find((e) => e.kind === kind) as Extract<Effect, { kind: K }> | undefined;
// The engine's private helpers, for checks that don't need a whole turn.
type Inside = {
  destroy(perm: Perm): void;
  removePerm(perm: Perm, to: 'graveyard' | 'exile' | 'hand' | 'library'): void;
  toGraveyard(p: PlayerState, card: unknown, isCommander: boolean): void;
  extraTriggers(p: PlayerState, src: Perm, effects: Effect[]): number;
};
const inside = (t: Table) => t.game as unknown as Inside;

const torbran = () => creature('Torbran, Thane of Red Fell', '{1}{R}{R}{R}', 4, 2, 4, { superTypes: ['Legendary'], text: 'If a red source you control would deal damage to an opponent or a permanent an opponent controls, it deals that much damage plus 2 instead.' });
const goblin = () => creature('Raging Goblin', '{R}', 1, 1, 1, { keywords: ['Haste'], text: 'Haste' });
const gisela = () => creature('Gisela, Blade of Goldnight', '{4}{R}{W}{W}', 7, 5, 5, { text: 'Flying, first strike\nIf a source would deal damage to an opponent or a permanent an opponent controls, that source deals double that damage to that player or permanent instead.\nIf a source would deal damage to you or a permanent you control, prevent half that damage, rounded up.' });
const archive = () => spell("Alhammarret's Archive", '{5}', 5, 'Artifact', "If you would gain life, you gain twice that much life instead.\nIf you would draw a card except the first one you draw in each of your draw steps, draw two cards instead.");
const vortex = () => spell('Sulfuric Vortex', '{1}{R}{R}', 3, 'Enchantment', "At the beginning of each player's upkeep, this enchantment deals 2 damage to that player.\nIf a player would gain life, that player gains no life instead.");
const remedy = () => spell('Tainted Remedy', '{2}{B}', 3, 'Enchantment', 'If an opponent would gain life, that player loses that much life instead.');
const familiar = () => creature('Nightscape Familiar', '{1}{B}', 2, 1, 1, { text: 'Blue spells and red spells you cast cost {1} less to cast.\n{1}{B}: Regenerate this creature.' });
const curiosity = () => creature('Enduring Curiosity', '{2}{U}{U}', 4, 4, 3, { types: ['Enchantment', 'Creature'], subTypes: ['Cat', 'Glimmer'], text: "Flash\nWhenever a creature you control deals combat damage to a player, draw a card.\nWhen Enduring Curiosity dies, if it was a creature, return it to the battlefield under its owner's control. It's an enchantment. (It's not a creature.)" });
const gisa = () => creature('Gisa, Glorious Resurrector', '{2}{B}{B}', 4, 4, 4, { superTypes: ['Legendary'], text: "If a creature an opponent controls would die, exile it instead.\nAt the beginning of your upkeep, put all creature cards exiled with Gisa onto the battlefield under your control. They gain decayed. (A creature with decayed can't block. When it attacks, sacrifice it at end of combat.)" });
const nexus = () => spell('Nexus of Fate', '{5}{U}{U}', 7, 'Instant', "Take an extra turn after this one.\nIf Nexus of Fate would be put into a graveyard from anywhere, reveal Nexus of Fate and shuffle it into its owner's library instead.");
const sheoldred = () => creature('Sheoldred, the Apocalypse', '{2}{B}{B}', 4, 4, 5, { text: 'Deathtouch\nWhenever you draw a card, you gain 2 life.\nWhenever an opponent draws a card, they lose 2 life.' });
const prodigy = () => creature('Harmonic Prodigy', '{1}{R}', 2, 1, 3, { subTypes: ['Human', 'Wizard'], text: 'Prowess\nIf a triggered ability of a Shaman or another Wizard you control triggers, that ability triggers an additional time.' });
const throne = () => creature('Roaming Throne', '{4}', 4, 4, 4, { types: ['Artifact', 'Creature'], subTypes: ['Golem'], text: 'Ward {2}\nAs this creature enters, choose a creature type.\nThis creature is the chosen type in addition to its other types.\nIf a triggered ability of another creature you control of the chosen type triggers, it triggers an additional time.' });
const vindicator = () => creature('Phyrexian Vindicator', '{W}{W}{W}{W}', 4, 5, 5, { text: 'Flying\nIf damage would be dealt to this creature, prevent that damage. When damage is prevented this way, this creature deals that much damage to any other target.' });
const spike = () => spell('Quietus Spike', '{3}', 3, 'Artifact', 'Equipped creature has deathtouch.\nWhenever equipped creature deals combat damage to a player, that player loses half their life, rounded up.\nEquip {3}', { subTypes: ['Equipment'] });
const broodmoth = () => creature('Luminous Broodmoth', '{2}{W}{W}', 4, 3, 4, { text: 'Flying\nWhenever a creature you control without flying dies, return it to the battlefield under its owner\'s control with a flying counter on it.' });
const bolt = () => spell('Lightning Bolt', '{R}', 1, 'Instant', 'Lightning Bolt deals 3 damage to any target.');

describe('reading replacement effects', () => {
  it('reads damage replacements with their source, victim and size', () => {
    expect(effect(torbran(), 'damageMod')).toMatchObject({ op: 'plus', n: 2, from: 'yours', to: 'opponents', color: 'R', when: 'static' });
    const g = gisela();
    expect(g.effects.filter((e) => e.kind === 'damageMod').map((e) => e.kind === 'damageMod' && e.op)).toEqual(['times', 'preventHalf']);
    expect(effect(vindicator(), 'damageMod')).toMatchObject({ op: 'prevent', to: 'self', reflect: true });
    expect(torbran().unread ?? []).toEqual([]);
  });

  it('reads life-gain replacements', () => {
    expect(effect(archive(), 'lifeRule')).toMatchObject({ rule: 'double', who: 'you' });
    expect(effect(vortex(), 'lifeRule')).toMatchObject({ rule: 'noGain', who: 'all' });
    expect(effect(remedy(), 'lifeRule')).toMatchObject({ rule: 'lossInstead', who: 'opponents' });
  });

  it('reads death replacements, returns and trigger doublers', () => {
    expect(effect(curiosity(), 'returnAs')).toMatchObject({ as: 'enchantment', when: 'creatureDies', scope: 'self' });
    expect(curiosity().effects.find((e) => e.kind === 'returnAs')?.chance).toBeUndefined();
    expect(effect(gisa(), 'deathExile')).toMatchObject({ keep: true });
    expect(effect(gisa(), 'reanimateExiled')).toMatchObject({ all: true, when: 'upkeep' });
    expect(effect(nexus(), 'shuffleInstead')).toBeDefined();
    expect(effect(prodigy(), 'triggerDoubler')).toMatchObject({ subtypes: ['Shaman', 'Wizard'], other: true });
    expect(effect(throne(), 'triggerDoubler')).toMatchObject({ chosenType: true });
    expect(effect(broodmoth(), 'returnDied')).toMatchObject({ kw: 'flying', filter: 'noFlying' });
    for (const c of [curiosity(), gisa(), nexus(), prodigy(), throne(), broodmoth()]) expect(c.unread ?? [], c.name).toEqual([]);
  });

  it('reads "that player" as the player the trigger is about', () => {
    const e = sheoldred().effects.find((f) => f.when === 'opponentDraw');
    expect(e).toMatchObject({ kind: 'damagePlayer', n: 2, lifeLoss: true, thatPlayer: true });
    expect(effect(spike(), 'loseHalf')).toMatchObject({ when: 'combatDamage', thatPlayer: true });
  });

  it('reads regenerate as a regeneration shield, not indestructible', () => {
    const e = familiar().effects.find((f) => f.when === 'activated');
    expect(e).toMatchObject({ kind: 'pump', grant: ['regenerate'], self: true });
  });
});

describe('damage replacement and prevention (rules 614.1a, 615)', () => {
  it("Torbran: a red creature's combat damage to an opponent gets +2 (and a green one's doesn't)", () => {
    const t = new Table();
    t.game.put(0, torbran());
    t.game.put(0, goblin());
    t.game.put(0, creature('Grizzly Bears', '{1}{G}', 2, 2, 2));
    t.handlers[0] = attackAll(1);
    t.finishTurn();
    // Goblin 1+2, Bears 2, Torbran (red) 2+2.
    expect(t.game.players[1].life).toBe(40 - 3 - 2 - 4);
  });

  it('Gisela doubles damage to opponents and halves damage to its controller', () => {
    const t = new Table();
    t.game.put(0, gisela());
    const bolted = t.game.damageAfter(t.game.players[1], bolt(), null, t.game.players[0], 3, false);
    expect(bolted).toBe(1); // 3, half rounded up (2) prevented
    expect(t.game.damageAfter(t.game.players[0], bolt(), null, t.game.players[1], 3, false)).toBe(6);
  });

  it('Phyrexian Vindicator prevents damage to itself and deals it to another target', () => {
    const t = new Table();
    const v = t.game.put(0, vindicator());
    expect(t.game.damageAfter(t.game.players[1], bolt(), null, v, 3, false)).toBe(0);
    expect(log(t, /Phyrexian Vindicator prevents 3 damage/)).toHaveLength(1);
  });
});

describe('life-gain replacements', () => {
  it("Alhammarret's Archive doubles your life gain; Sulfuric Vortex stops it; Tainted Remedy turns it into loss", () => {
    const t = new Table();
    const [me, foe] = t.game.players;
    t.game.put(0, archive());
    t.game.gainLife(me, 3);
    expect(me.life).toBe(46);
    t.game.put(0, remedy());
    t.game.gainLife(foe, 4);
    expect(foe.life).toBe(36);
    t.game.put(1, vortex());
    t.game.gainLife(me, 3);
    t.game.gainLife(foe, 3);
    expect(me.life).toBe(46);
    expect(foe.life).toBe(36);
  });
});

describe('regeneration (rule 701.19)', () => {
  it('a regeneration shield replaces being destroyed: tapped, damage removed, out of combat', () => {
    const t = new Table();
    const f = t.game.put(0, familiar());
    f.tempKw.push('regenerate');
    f.damage = 1;
    inside(t).destroy(f);
    expect(t.game.players[0].battlefield).toContain(f);
    expect(f.tapped).toBe(true);
    expect(f.damage).toBe(0);
    // The shield is used up.
    inside(t).destroy(f);
    expect(t.game.players[0].battlefield).not.toContain(f);
  });
});

describe('death and leave-the-battlefield replacements', () => {
  it('Enduring Curiosity returns as an enchantment that is not a creature', () => {
    const t = new Table();
    const c = t.game.put(0, curiosity());
    t.game.put(1, creature('Doom Blade Caster', '{G}', 1, 1, 1));
    t.game.players[1].hand.push(spell('Murder', '{G}', 1, 'Instant', 'Destroy target creature.'));
    t.lands(1, 2);
    t.handlers[1] = castOnce('Murder', (g) => g.step === 'main1');
    t.finishTurn();
    const back = t.game.players[0].battlefield.find((q) => q.card.name === 'Enduring Curiosity');
    expect(back).toBeDefined();
    expect(back).not.toBe(c);
    expect(back!.card.isCreature).toBe(false);
    expect(back!.card.isEnchantment).toBe(true);
    // Back as a real card in the graveyard if it leaves again.
    inside(t).removePerm(back!, 'graveyard');
    expect(t.game.players[0].graveyard.at(-1)?.isCreature).toBe(true);
  });

  it("Gisa exiles opponents' dying creatures and brings them back at its controller's upkeep, with decayed", () => {
    const t = new Table();
    t.game.put(0, gisa());
    const bear = t.game.put(1, creature('Grizzly Bears', '{1}{G}', 2, 2, 2));
    inside(t).destroy(bear);
    expect(t.game.players[1].graveyard.map((c) => c.name)).not.toContain('Grizzly Bears');
    expect(t.game.players[1].exile.map((c) => c.name)).toContain('Grizzly Bears');
    t.finishTurn();
    t.finishTurn();
    t.until((g) => g.step === 'main1' && g.activeSeat === 0);
    const back = t.game.players[0].battlefield.find((q) => q.card.name === 'Grizzly Bears');
    expect(back).toBeDefined();
    expect(back!.kwCounters).toContain('decayed');
  });

  it('Nexus of Fate is shuffled into its library instead of going to the graveyard', () => {
    const t = new Table();
    const me = t.game.players[0];
    const n = nexus();
    inside(t).toGraveyard(me, n, false);
    expect(me.graveyard).not.toContain(n);
    expect(me.library).toContain(n);
  });

  it('Luminous Broodmoth returns a creature without flying with a flying counter', () => {
    const t = new Table();
    t.game.put(0, broodmoth());
    const bear = t.game.put(0, creature('Grizzly Bears', '{1}{G}', 2, 2, 2));
    t.game.players[1].hand.push(spell('Murder', '{G}', 1, 'Instant', 'Destroy target creature.'));
    t.lands(1, 2);
    t.handlers[1] = (g, d) => {
      if (d.kind === 'target') return d.candidates.find((c) => c.kind === 'perm' && c.id === bear.id) ?? d.candidates[0];
      return castOnce('Murder', (gg) => gg.step === 'main1')(g, d);
    };
    t.finishTurn();
    const back = t.game.players[0].battlefield.find((q) => q.card.name === 'Grizzly Bears');
    expect(back).toBeDefined();
    expect(back!.kwCounters).toContain('flying');
  });
});

describe('trigger doublers (rule 603.2d)', () => {
  it("Harmonic Prodigy doubles other Wizards' triggers, not its own; Roaming Throne the chosen type's", () => {
    const t = new Table();
    const me = t.game.players[0];
    const p = t.game.put(0, prodigy());
    const wizard = t.game.put(0, creature('Young Pyromancer', '{1}{R}', 2, 2, 1, { subTypes: ['Human', 'Shaman'] }));
    const bear = t.game.put(0, creature('Grizzly Bears', '{1}{G}', 2, 2, 2, { subTypes: ['Bear'] }));
    expect(inside(t).extraTriggers(me, wizard, [])).toBe(1);
    expect(inside(t).extraTriggers(me, p, [])).toBe(0);
    expect(inside(t).extraTriggers(me, bear, [])).toBe(0);
    const th = t.game.put(0, throne());
    th.chosenType = 'Bear';
    expect(inside(t).extraTriggers(me, bear, [])).toBe(1);
  });
});

describe('"that player" triggers', () => {
  it('Sheoldred: an opponent loses 2 life for each card they draw', () => {
    const t = new Table();
    t.game.put(0, sheoldred());
    const foe = t.game.players[1];
    t.finishTurn();
    t.until((g) => g.activeSeat === 1 && g.step === 'main1');
    expect(foe.life).toBe(38);
    expect(log(t, /loses 2 life/).length).toBeGreaterThan(0);
  });

  it('Quietus Spike: the player hit loses half their life, rounded up', () => {
    const t = new Table();
    const bear = t.game.put(0, creature('Grizzly Bears', '{1}{G}', 2, 2, 2));
    const s = t.game.put(0, spike());
    s.attachedTo = bear.id;
    (t.game as unknown as { anyAttached: boolean }).anyAttached = true;
    t.handlers[0] = attackAll(1);
    t.finishTurn();
    // 40 - 2 = 38, then half of 38.
    expect(t.game.players[1].life).toBe(19);
  });
});
