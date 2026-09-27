# Proliferate

Import your Commander decks from [Archidekt](https://archidekt.com), then let them play each other again and again under the full Magic rules to see how they really compare. Every game is played by [Forge](https://github.com/Card-Forge/forge), the open-source Magic rules engine with ~33,000 scripted cards and its own AI.

- **Import**: link your Archidekt account (lists all your public decks and syncs ones you've changed), paste a deck link, or upload/paste a text decklist.
- **Simulate** balanced random pods for as long as you like — until you stop, for a set time, or a set number of games. Several Forge games run in parallel.
- **Leaderboard**: strength rating, win rate with confidence range, average place, how each deck kills, commander cast turn, average mulligans — overall or by player count (2–6).
- **Compare** up to six decks side by side, including deck makeup and bracket.
- **Deck report**: estimated **Commander Bracket** with reasons, and **card performance** — which cards pull their weight.
- **Playstyle**: answer an endless stream of real board-state questions; your answers tune a **Forge AI personality** so your decks can be piloted your way.
- **Watch a game**: play-by-play of the latest Forge game.

Decks and results are saved in your browser; simulations run on your own computer.

## Running it

Requires [Node.js](https://nodejs.org) 20+ and Java 17+ ([Adoptium](https://adoptium.net) is fine).

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

## How simulations work

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
  engine/     card classifier and the internal board engine used for quiz board states
  import/     Archidekt + text/Scryfall importers, deck search
  sim/        Forge client, pod selection, run limits, statistics
  analysis/   bracket estimate, card performance, deck composition
  ai/         Forge personality learning and quiz scenarios
  ui/         React components
server/       Forge runner: deck conversion, AI profiles, process pool, log parser (Vite plugin)
scripts/      setup-forge.mjs
api/          Archidekt proxy (shared by Vite and Vercel)
tests/        Vitest unit tests
```

Card data © Wizards of the Coast. Proliferate is unofficial Fan Content permitted under the Fan Content Policy. Not approved/endorsed by Wizards.
