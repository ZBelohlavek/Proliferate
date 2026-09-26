# Proliferate

Upload your Commander decks from [Archidekt](https://archidekt.com), then let them play thousands of simulated 4-player EDH games against each other to see how they stack up.

- **Import** decks from an Archidekt link, or upload/paste a text decklist (card data comes from Scryfall).
- **Simulate continuously** in the background on all your CPU cores — typically a few thousand games per second.
- **Compare** with a leaderboard (strength rating, win rate with confidence intervals, average finishing place, how each deck kills), a head-to-head grid, and a rating-over-time chart.
- **Watch a game** turn by turn to see how the AI pilots your cards.
- **Audit** how each card is interpreted, and which ones the simulator doesn't understand.

Everything runs in your browser. Decks and results are saved in your browser's local storage.

## Running it

Requires [Node.js](https://nodejs.org) 20 or newer.

```bash
npm install
npm run dev
```

Then open http://localhost:5173.

Other commands:

| Command | What it does |
| --- | --- |
| `npm test` | Run the unit tests |
| `npm run build` | Type-check and build the static site into `dist/` |
| `npm run preview` | Serve the production build locally |

### Deploying

The site is static except for one tiny endpoint: Archidekt's API doesn't allow requests from other websites, so deck imports go through `/api/archidekt?id=…`. In development, Vite serves that endpoint (see `vite.config.ts`). For hosting, `api/archidekt.js` is a ready-made [Vercel](https://vercel.com) function — importing the repo into Vercel deploys both the site and the endpoint with no configuration. On a host without serverless functions, text-decklist import still works (Scryfall allows browser requests).

## How the simulation works

This is **not** a full Magic rules engine — nothing short of [Forge](https://github.com/Card-Forge/forge) is. Instead:

1. **Card interpretation** (`src/engine/classify.ts`). Each card's oracle text is matched against patterns for common Commander effects: ramp, mana rocks and dorks, card draw, spot removal, board wipes, counterspells, tokens, anthems, equipment, combat tricks, drain/burn, tutors, recursion, cost reduction and extra lands. It also recognises when they happen: on cast/ETB, each turn, on attack, on combat damage, when you cast a spell, when a creature enters or dies, landfall, and activated abilities. Conditional triggers ("if…") fire about half the time. Anything unrecognised is played as a blank card; the Decks tab shows the percentage modeled and lists every card's interpretation.

2. **The game** (`src/engine/game.ts`). Real turn structure with Commander rules: 40 life, command zone and commander tax, 21 commander damage, free first mulligan then London mulligans, decking. Combat supports flying/reach, trample, first and double strike, deathtouch, lifelink, menace, vigilance, indestructible, hexproof and unblockable.

3. **The AI** is heuristic: it plays lands to fix colors, ramps early, holds up counterspells, removes the biggest threat (weighted toward the table leader), wipes when the board is against it, picks attack targets by threat and life total, avoids bad attacks, chump-blocks to survive, and uses instants at the end of the previous player's turn.

4. **Statistics** (`src/sim/stats.ts`). Every game is treated as a set of pairwise matches: each deck "beats" every deck it outlasted. A Bradley–Terry model fitted to all of those matches gives the **rating** (Elo scale: 1500 is average, +100 ≈ a 64% chance to outlast an average deck). Pods are drawn so every deck plays about the same number of games, with random seating.

### Limitations — read before trusting the numbers

- Combos, infinite loops, extra turns/combats, stax, theft, copy effects, most planeswalker ultimates, and "cheat into play" effects (Kaalia, Sneak Attack…) aren't modeled. Combo decks and heavy-synergy decks will be **underrated**; simple value/beatdown decks are modeled best.
- The AI plays reasonably but not like a strong human: no politics, no bluffing, no complex sequencing.
- Treat results as a **relative** comparison between your decks under the same simplified rules, not as a prediction of real win rates. The "% modeled" figure tells you how much of each deck the simulator actually sees.

## Project layout

```
src/
  engine/     types, oracle-text classifier, game engine, seeded RNG
  import/     Archidekt + text/Scryfall importers
  sim/        Web Worker, worker pool controller, statistics
  ui/         React components
api/          Vercel serverless proxy for Archidekt
tests/        Vitest unit tests
```

Card data © Wizards of the Coast. Proliferate is unofficial Fan Content permitted under the Fan Content Policy. Not approved/endorsed by Wizards.
