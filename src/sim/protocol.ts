// Messages exchanged between the page and simulation workers.

import type { GameResult, SimDeck } from '../engine/types';
import type { Weights } from '../ai/playstyle';

export type WorkerRequest =
  | { type: 'start'; decks: SimDeck[]; podSize: number; maxRounds: number; seed: number; playstyle: Weights | null }
  | { type: 'stop' }
  | { type: 'sample'; decks: SimDeck[]; seed: number; maxRounds: number; playstyle: Weights | null };

export type WorkerResponse =
  | { type: 'results'; results: GameResult[] }
  | { type: 'sample'; result: GameResult; log: string[] }
  | { type: 'error'; message: string };
