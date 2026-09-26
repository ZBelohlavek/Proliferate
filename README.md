# Proliferate

Upload your Commander decks from [Archidekt](https://archidekt.com), then let them play thousands of simulated 4-player EDH games against each other to see how they stack up.

- **Import** decks from an Archidekt link, or upload/paste a text decklist (card data comes from Scryfall).
- **Two engines:**
  - **Quick** — a built-in simplified engine that runs in the browser at a few thousand games per second.
  - **Accurate** — full Magic rules via [Forge](https://github.com/Card-Forge/forge), the open-source rules engine with ~33,000 scripted cards and its own AI. A few games per minute, run locally.
- **Compare** with a leaderboard (strength rating, win rate with confidence intervals, average finishing place, how each deck kills), a head-to-head grid, and a rating-over-time chart.
- **Compare** up to six decks side by side: bracket, results from both engines, mana curve, ramp/draw/removal counts, strongest and weakest cards.
- **Deck report**: an estimated **Commander Bracket** with the reasons behind it, and **card performance** — which cards help or hurt the deck when they show up.
- **Watch a game** turn by turn to see how the AI pilots your cards.
- **Audit** how each card is interpreted, and which ones the simulator doesn't understand.

Decks and results are saved in your browser's local storage; each engine keeps its own results.

## Running it

Requires [Node.js](https://nodejs.org) 20 or newer.

```bash
npm install
npm run dev
```

Then open http://localhost:5173.

### Accurate mode (Forge)

Needs Java 17+ ([Adoptium](https://adoptium.net) is fine). Then:

```bash
npm run setup:forge
```

This downloads the latest Forge release (~300 MB) into `../forge` and gives it its own data folder (`../forge-data`), so it never touches a Forge install you play with yourself. Set `FORGE_DIR` to put it elsewhere. Then run `npm run dev`, open the Simulate tab and pick **Accurate (Forge)**.

How it works: the dev server converts each deck to a Forge `.dck` file, then runs a pool of `java -jar forge.jar sim -d … -f commander` processes on balanced random pods and parses each game log (elimination order, cause of death, commander cast turn, mulligans) into the same statistics the quick engine produces. Each game uses several CPU cores and about 1 GB of RAM; on a 24-thread desktop, 6–8 parallel processes give roughly 3–6 games a minute. Games keep running while the browser tab is closed, as long as the dev server is up. Cards Forge doesn't know are reported and left out.

Other commands:

| Command | What it does |
| --- | --- |
| `npm test` | Run the unit tests |
| `npm run setup:forge` | Download and configure Forge for Accurate mode |
| `npm run build` | Type-check and build the static site into `dist/` |
| `npm run preview` | Serve the production build locally |

### Deploying

Quick mode deploys as a static site. Accurate mode needs Forge and Java on the machine running the server, so it only works locally (or on a server you run yourself). The static site has one tiny endpoint: Archidekt's API doesn't allow requests from other websites, so deck imports go through `/api/archidekt?id=…`. In development, Vite serves that endpoint (see `vite.config.ts`). For hosting, `api/archidekt.js` is a ready-made [Vercel](https://vercel.com) function — importing the repo into Vercel deploys both the site and the endpoint with no configuration. On a host without serverless functions, text-decklist import still works (Scryfall allows browser requests).

## Brackets

The estimate follows the official [Commander Brackets](https://magic.wizards.com/en/formats/commander#brackets) (beta, February 2026 update):

- **Game Changers** — the one hard rule: none in Brackets 1–2, up to three in Bracket 3, any number in 4–5.
- **Barometers** — two-card infinite combos, chained extra turns and mass land denial push a deck up (fast two-card combos and land denial to 4+).
- **Speed** — brackets are defined by how many turns a game should last (9+, 8+, 6+, 4+, any). With enough Accurate (Forge) wins, the deck's actual winning turns are checked against that.

Game Changers, land denial, extra turns and combos come from [Commander Spellbook](https://commanderspellbook.com)'s bracket API, which tracks the current lists. Bracket 1 is about theme rather than power, so a Bracket 2 result reads "or 1 if theme-first".

## Card performance

For each game the quick engine records which cards the shuffle placed in the opening hand or the next 8 cards. That's pure luck, so comparing how the deck finishes in games where a card started early against games where it didn't is a fair test of the card — the same idea as 17lands' "improvement when drawn". (Comparing games where a card was merely *drawn* would be biased: decks that survive longer draw more, so every card looks good.) Each impact comes with a 95% margin of error, and a card is only called weak or strong when the whole range is on one side of zero. Cards held in hand most of the time are flagged separately, and cards the quick engine can't read aren't judged.

Forge logs don't reveal draws, so the Forge view uses "games where the card was cast" — useful for ranking cards against each other, but biased upward.

## How the quick engine works

The quick engine is **not** a full rules engine — use Accurate mode when that matters. Instead:

1. **Card interpretation** (`src/engine/classify.ts`). Each card's oracle text is matched against patterns for common Commander effects: ramp, mana rocks and dorks, card draw, spot removal, board wipes, counterspells, tokens, anthems, equipment, combat tricks, drain/burn, tutors, recursion, cost reduction and extra lands. It also recognises when they happen: on cast/ETB, each turn, on attack, on combat damage, when you cast a spell, when a creature enters or dies, landfall, and activated abilities. Conditional triggers ("if…") fire about half the time. Anything unrecognised is played as a blank card; the Decks tab shows the percentage modeled and lists every card's interpretation.

2. **The game** (`src/engine/game.ts`). Real turn structure with Commander rules: 40 life, command zone and commander tax, 21 commander damage, free first mulligan then London mulligans, decking. Combat supports flying/reach, trample, first and double strike, deathtouch, lifelink, menace, vigilance, indestructible, hexproof and unblockable.

3. **The AI** is heuristic: it plays lands to fix colors, ramps early, holds up counterspells, removes the biggest threat (weighted toward the table leader), wipes when the board is against it, picks attack targets by threat and life total, avoids bad attacks, chump-blocks to survive, and uses instants at the end of the previous player's turn.

4. **Statistics** (`src/sim/stats.ts`). Every game is treated as a set of pairwise matches: each deck "beats" every deck it outlasted. A Bradley–Terry model fitted to all of those matches gives the **rating** (Elo scale: 1500 is average, +100 ≈ a 64% chance to outlast an average deck). Pods are drawn so every deck plays about the same number of games, with random seating.

### Quick-engine limitations — read before trusting the numbers

- Combos, infinite loops, extra turns/combats, stax, theft, copy effects, most planeswalker ultimates, and "cheat into play" effects (Kaalia, Sneak Attack…) aren't modeled. Combo decks and heavy-synergy decks will be **underrated**; simple value/beatdown decks are modeled best.
- The AI plays reasonably but not like a strong human: no politics, no bluffing, no complex sequencing.
- Treat results as a **relative** comparison between your decks under the same simplified rules, not as a prediction of real win rates. The "% modeled" figure tells you how much of each deck the simulator actually sees.

Accurate mode removes these limits, but results still reflect **Forge's AI**, which plays reasonably but misses some combos and makes political mistakes a human wouldn't.

## Project layout

```
src/
  engine/     types, oracle-text classifier, game engine, seeded RNG
  import/     Archidekt + text/Scryfall importers
  sim/        Web Worker pool, Forge client, statistics
  analysis/   bracket estimate, card performance, deck composition
  ui/         React components
server/       Forge runner: deck conversion, process pool, log parser (Vite plugin)
scripts/      setup-forge.mjs
api/          Vercel serverless proxy for Archidekt
tests/        Vitest unit tests
```

Card data © Wizards of the Coast. Proliferate is unofficial Fan Content permitted under the Fan Content Policy. Not approved/endorsed by Wizards.
