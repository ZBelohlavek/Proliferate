// Cards from the real decks the reader used to read nothing on at all: rarer
// wordings (see src/engine/classifyRare.ts) and two triggers, "whenever an
// opponent discards a card" and "whenever an opponent loses life".

import { describe, expect, it } from 'vitest';
import { creature, spell } from './helpers';
import { castOnce, Table } from './table';

const kinds = (c: { effects: { kind: string; when: string }[] }) => c.effects.map((e) => `${e.when}:${e.kind}`);

describe('rarer wordings', () => {
  const cases: [string, string, string, string, string[]][] = [
    ['Lotus Petal', '{0}', 'Artifact', '{T}, Sacrifice Lotus Petal: Add one mana of any color.', ['resolve:treasure']],
    ['Chrome Mox', '{0}', 'Artifact', "Imprint — When Chrome Mox enters, you may exile a nonartifact, nonland card from your hand.\n{T}: Add one mana of any of the exiled card's colors.", ['static:mana']],
    ['Mox Opal', '{0}', 'Legendary Artifact', 'Metalcraft — {T}: Add one mana of any color. Activate only if you control three or more artifacts.', ['static:mana']],
    ['Duress', '{B}', 'Sorcery', 'Target opponent reveals their hand. You choose a noncreature, nonland card from it. That player discards that card.', ['resolve:discard']],
    ['Disallow', '{1}{U}{U}', 'Instant', 'Counter target spell, activated ability, or triggered ability.', ['resolve:counter']],
    ['Deflecting Swat', '{2}{R}', 'Instant', 'If you control a commander, you may cast this spell without paying its mana cost.\nYou may choose new targets for target spell or ability.', ['resolve:counter']],
    ['Duneblast', '{4}{W}{B}{G}', 'Sorcery', 'Choose up to one creature. Destroy the rest.', ['resolve:wipe']],
    ["Council's Judgment", '{1}{W}{W}', 'Sorcery', "Will of the council — Starting with you, each player votes for a nonland permanent you don't control. Exile each permanent with the most votes or tied for most votes.", ['resolve:removal']],
    ['Howling Mine', '{2}', 'Artifact', "At the beginning of each player's draw step, if Howling Mine is untapped, that player draws an additional card.", ['upkeep:draw']],
    ['Villainous Wealth', '{X}{B}{G}{U}', 'Sorcery', 'Target opponent exiles the top X cards of their library. You may cast any number of spells with mana value X or less from among them without paying their mana costs.', ['resolve:draw']],
    ['Whispersilk Cloak', '{3}', 'Artifact', "Equipped creature can't be blocked and has shroud.\nEquip {2}", ['static:equip']],
    ['Blind Obedience', '{1}{W}', 'Enchantment', 'Extort\nArtifacts and creatures your opponents control enter tapped.', ['cast:drain']],
    ['Invasion of Eldraine', '{3}{B}', 'Battle', 'When this Siege enters, target opponent discards two cards.', ['resolve:discard']],
    ['Fake Your Own Death', '{1}{B}', 'Instant', 'Until end of turn, target creature gets +2/+0 and gains "When this creature dies, return it to the battlefield tapped under its owner\'s control and you create a Treasure token."', ['resolve:pump']],
  ];
  for (const [name, cost, type, text, expected] of cases) {
    it(`reads ${name}`, () => {
      const c = spell(name, cost, 1, type, text);
      expect(c.modeled).toBe(true);
      expect(kinds(c)).toEqual(expected);
      expect(c.unread ?? []).toEqual(name === 'Chrome Mox' ? [expect.stringMatching(/^imprint/)] : name === 'Blind Obedience' ? [expect.stringMatching(/enter tapped/)] : []);
    });
  }

  it('leaves Mindcrank to its own rule', () => {
    const c = spell('Mindcrank', '{2}', 2, 'Artifact', 'Whenever an opponent loses life, that player mills that many cards.');
    expect(kinds(c)).toEqual(['static:lifeLossMill']);
  });
});

describe('opponent triggers', () => {
  it('Exquisite Blood gains what an opponent loses', () => {
    const t = new Table();
    const [a, b] = t.game.players;
    t.game.put(0, spell('Exquisite Blood', '{4}{B}', 5, 'Enchantment', 'Whenever an opponent loses life, you gain that much life.'));
    const life = a.life;
    t.game.loseLife(b, 3, a, 'noncombat');
    t.finishTurn();
    expect(a.life).toBe(life + 3);
  });

  it('Liliana\'s Caress drains for each card an opponent discards', () => {
    const t = new Table();
    const [a, b] = t.game.players;
    t.lands(0, 3);
    t.game.put(0, spell("Liliana's Caress", '{1}{B}', 2, 'Enchantment', 'Whenever an opponent discards a card, that player loses 2 life.'));
    b.hand.push(creature('Grizzly Bears', '{1}{G}', 2, 2, 2), creature('Grizzly Bears', '{1}{G}', 2, 2, 2));
    a.hand.push(spell('Mind Rot', '{3}', 3, 'Sorcery', 'Target player discards two cards.'));
    const life = b.life;
    t.handlers[0] = castOnce('Mind Rot');
    t.finishTurn();
    expect(b.graveyard.filter((c) => c.name === 'Grizzly Bears')).toHaveLength(2);
    expect(b.life).toBe(life - 4);
  });
});
