# Proliferate

Import your Commander decks from [Archidekt](https://archidekt.com), play them yourself against bots, and let them play each other again and again to see how they really compare.

Two engines play the games:

- **Proliferate's own engine** runs in the browser. It has the real turn structure, priority, the stack, combat and the Commander rules, and its own bot AI. You can sit at the table yourself, and it simulates thousands of games a minute. It reads card text approximately.
- **[Forge](https://github.com/Card-Forge/forge)**, the open-source Magic rules engine with ~33,000 scripted cards and its own AI, plays bot-versus-bot games under the full rules on your own computer.

- **Import**: link your Archidekt account (lists all your public decks and syncs ones you've changed), paste a deck link, or upload/paste a text decklist.
- **Play** one of your decks against 1–5 bots: click cards to cast them, declare attackers and blockers, respond on the stack.
- **Simulate** balanced random pods for as long as you like — until you stop, for a set time, or a set number of games — on either engine. Results are kept separately per engine.
- **Leaderboard**: strength rating, win rate with confidence range, average place, how each deck kills, commander cast turn, average mulligans — overall or by player count (2–6).
- **Compare** up to six decks side by side, including deck makeup and bracket.
- **Deck report**: estimated **Commander Bracket** with reasons, and **card performance** — which cards pull their weight.
- **Playstyle**: answer an endless stream of real board-state questions; your answers tune a **Forge AI personality** so your decks can be piloted your way.
- **Watch a game**: play-by-play of a fresh game on the built-in engine, or of the latest Forge game.

Decks and results are saved in your browser; simulations run on your own computer.

## Running it

Requires [Node.js](https://nodejs.org) 20+. Forge also needs Java 17+ ([Adoptium](https://adoptium.net) is fine); playing against bots and the built-in simulator work without it, so you can skip `setup:forge`.

```bash
npm install
npm run setup:forge
npm run dev
```

`setup:forge` downloads the latest Forge release (~300 MB) into `../forge` and gives it its own data folder (`../forge-data`), so it never touches a Forge install you play with yourself. Set `FORGE_DIR` to put it elsewhere. Then open http://localhost:5173.

| Command | What it does |
| --- | --- |
| `npm run dev` | Start the site and the Forge runner |
| `npm run setup:forge` | Download and configure Forge |
| `npm test` | Run the unit tests |
| `npm run build` | Type-check and build |

## Proliferate's own engine

`src/rules/` is a rules engine and bot AI written for this app.

**The engine** (`game.ts`) follows the Comprehensive Rules for everything it models, with rule numbers in the comments:

- Turn structure: untap, upkeep, draw, main, beginning of combat, declare attackers, declare blockers, combat damage (with a separate first-strike step), end of combat, second main, end step, cleanup.
- Priority and the stack: players get priority in turn order; spells, activated abilities and triggered abilities go on the stack and can be responded to; a spell whose targets have all become illegal doesn't resolve.
- Combat: each creature can attack a different opponent, defenders choose blocks, and flying, reach, menace, first strike, double strike, trample, deathtouch, lifelink, vigilance, haste, defender and indestructible work as written.
- State-based actions: life, lethal and deathtouch damage, zero toughness, drawing from an empty library, the legend rule, Auras with nothing to enchant, tokens leaving the battlefield.
- Commander: 40 life, the command zone, commander tax, the choice to return a commander to the command zone, 21 commander damage, the free first mulligan and London mulligans, players leaving a multiplayer game.

The engine never decides anything. It is a generator that yields a **decision** (what to do with priority, which target, which attackers, which blockers, what to discard…) and waits for the answer, so a person and bots can share a table (`session.ts`).

**The bot** (`bot.ts`) answers every decision from the public board and its own hand: mulligans, land choice, what to cast and when to hold mana, removal and counterspell targets, combat tricks, attacks split across opponents, blocks and chump blocks. It also plays to win without combat: it takes a burn, drain or mill spell or ability that finishes an opponent before anything else, feeds a sacrifice outlet when death triggers can drain the table out, plays mill cards harder in a deck built to mill, draws and mills itself with Laboratory Maniac or Jace out, holds thirteen cards with Triskaidekaphile, tutors for and slams the missing piece of a combo, and counters or removes opponents' combo pieces.

**Winning without combat** (`wincons.ts`): alternative win cards (Approach of the Second Sun, Laboratory Maniac, Jace, Revel in Riches, Triskaidekaphile, Hellkite Tyrant, Knuckles, Darksteel Reactor) and known two-card combos (Sanguine Bond or Vito with Exquisite Blood or Bloodthirsty Conqueror, Mindcrank with a charged Bloodchief Ascension, Isochron Scepter with Dramatic Reversal plus three mana of rocks and something to sink it into) are recognised by name, so they work in decks imported earlier. An assembled combo wins at once, as the shortcut of its loop (rule 727). A player who runs out of cards counts as knocked out by whoever milled them last, and proliferate adds poison counters.

**What a card does** comes from the classifier (`src/engine/classify.ts`), which matches oracle text against patterns for common Commander effects: ramp, rituals and Treasure, card draw, removal, wipes, counterspells, tokens, anthems, pump spells, Auras and Equipment, drain, tutors, reanimation, cloning, taking control, extra turns, sacrifice outlets, and rule-changing permanents (token and counter doublers, attack taxes, Rule of Law, Rest in Peace, Panharmonicon, extra land drops). Triggers are read for casting, attacking, dealing damage, entering, dying, sacrificing, landfall, your upkeep and end step, and for opponents casting spells or drawing cards. Hover a card at the table to see how it plays.

On a sample of 167 widely played Commander cards (`tests/staples.ts`) all but four are read. Real decks have a much longer tail of unusual text: across 66 real Commander decks (2,373 different nonland cards), 51% of the nonland cards are read in full, 34% in part, and 15% not at all. Hovering a card lists the lines that were **not read**. Decks are classified when they are imported, so re-import a deck to pick up improvements to the classifier. Known gaps:

- Text the classifier doesn't recognise does nothing; a card with no recognised text is marked **no effect**. A card can also be read in part, for example a creature that keeps its body and one of its two abilities.
- Mana is paid automatically, and mana doesn't float between spells. Ritual mana is kept as Treasures.
- Planeswalkers use one loyalty ability a turn and leave at zero loyalty, but they can't be attacked or damaged, and ultimates that make emblems aren't read.
- Tribal wording ("whenever a Dragon you control attacks") counts every creature you control. A stolen creature stays stolen even if the Aura that took it leaves. An attack tax is paid automatically when the attacker can afford it.
- Cycling, flashback, overload and storm are played by their rules. Power and toughness that count something are read for the common counts (cards in hand, graveyards, artifacts, creatures or lands you control); a count of one creature type counts every creature.
- Vehicles can be crewed in your first main phase only. Stun counters, spell taxes (Grand Arbiter, Thalia), Ankh of Mishra effects and toughness-as-damage (Arcades, Doran) are played. Kicker is never paid, votes always go to the last option, and mutate triggers happen about half the time.
- Not yet read: ninjutsu, mutate's merging (mutate creatures are cast as ordinary creatures), Sagas, Classes, goad, the Ring, energy, cast-from-exile and copy effects, alternative costs such as exiling a card from hand, and redirecting targets.
- "If" conditions it can't read are treated as true about half the time; ward costs {2}.
- Commander abilities from real decks are read where the engine can play them: Korvold's sacrifices, Kudo's 2/2s, Mathas's bounties, Garland's monarch theft, Meren's and Kratos's experience counters, Mr. House's dice, Satya's temporary token copies (energy is spent only on those), Tinybones's empty-hand drain, wither, self-pumps such as "{B}: gains haste" and regenerate (played as indestructible until end of turn), Background abilities, and triggers on surveilling, countering a spell or an opponent becoming the monarch. A modal trigger always takes its best option.

That makes the built-in simulator a quick estimate. Forge remains the reference for final numbers.

## How Forge simulations work

The dev server converts each deck to a Forge `.dck` file (checking every card against Forge's card list) and runs a pool of `java -jar forge.jar sim … -f commander` processes on balanced random pods. Each process can play several games back to back (`-n`) to skip Forge's ~8-second start-up, with a per-game time limit (`-c`, "Draw after") and an AI personality per player (`-a`). Each game log is parsed for finishing order, cause of death and killer, commander cast round, mulligans and every card cast, and folded into the statistics.

Every game counts as a set of pairwise matches — each deck "beats" every deck it outlasted — and a Bradley–Terry model fitted to all of them gives the **rating** (Elo scale: 1500 average, +100 ≈ 64% to outlast an average deck).

Forge's shuffles are fair: its AI "mana cheat" shuffle option only works when a game-level flag is set, which simulation mode never does.

### AI personalities

Forge's AI reads ~300 settings from a profile file (`forge/res/ai/*.ai`). You can pilot every deck with Forge's **Default**, **Cautious**, **Reckless** or **Experimental** profile, a **Mixed** table (random per player), or **You**: Default with the settings learned in the Playstyle quiz, written to `forge/res/ai/ProliferateYou.ai` when a run starts.

The quiz shows real board states from games with your deck (built by a small internal board engine) and asks one yes/no question each. Each question type maps to real Forge settings:

| Situation | Forge settings |
| --- | --- |
| Attack into a blocker that would trade? | `CHANCE_TO_ATTACK_INTO_TRADE`, `CHANCE_TO_ATKTRADE_WHEN_OPP_HAS_MANA`, `PLAY_AGGRO`, `ATTACK_INTO_TRADE_WHEN_TAPPED_OUT` |
| Counter a spell of mana value N? | `CHANCE_TO_COUNTER_CMC_1/2/3` |
| Cast a combat trick now or wait for blocks? | `TRY_TO_HOLD_COMBAT_TRICKS_UNTIL_BLOCK`, `CHANCE_TO_HOLD_COMBAT_TRICKS_UNTIL_BLOCK` |
| Block and trade, or take the damage? (by life total) | `MIN/MAX_CHANCE_TO_RANDOMLY_TRADE_ON_BLOCK` |
| Destroy an artifact/enchantment now or save removal? | `ACTIVELY_DESTROY_ARTS_AND_NONAURA_ENCHS` |

Your rate for each is blended with Forge's default (weighted as 4 answers), so early answers can't swing it too far. Things Forge's settings can't express — like who you consider the biggest threat, or how strict you are with mulligans — can't be learned this way.

### Card performance

Forge logs show what each player cast, not what they drew. Comparing games where a card was cast against games where it wasn't is biased upward (decks that survive longer cast more), so each card is reported **relative to the rest of the same deck** — its impact minus the deck's median card — with a 95% margin of error. Cards Forge's developers flag as ones its AI plays poorly are marked on the Decks tab.

## Brackets

The estimate follows the official [Commander Brackets](https://magic.wizards.com/en/formats/commander#brackets) (beta, February 2026 update): the Game Changer limits (none in Brackets 1–2, up to three in 3, any in 4–5), with two-card combos, extra turns, mass land denial and — once there are enough Forge wins — actual winning turns as barometers. Game Changers and combos come from [Commander Spellbook](https://commanderspellbook.com)'s bracket API.

## Project layout

```
src/
  rules/      Proliferate's own rules engine, bot AI and play sessions
  engine/     card classifier, plus the older board engine used for quiz board states
  import/     Archidekt + text/Scryfall importers, deck search
  sim/        Forge client, built-in simulator (Web Workers), pod selection, run limits, statistics
  analysis/   bracket estimate, card performance, deck composition
  ai/         Forge personality learning and quiz scenarios
  ui/         React components
server/       Forge runner: deck conversion, AI profiles, process pool, log parser (Vite plugin)
scripts/      setup-forge.mjs
api/          Archidekt proxy (shared by Vite and Vercel)
tests/        Vitest unit tests
```

Card data © Wizards of the Coast. Proliferate is unofficial Fan Content permitted under the Fan Content Policy. Not approved/endorsed by Wizards.
