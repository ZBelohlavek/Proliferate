// Web Worker: plays games on Proliferate's own rules engine in a loop and
// posts results back in batches. Running in a worker keeps the page
// responsive, and several workers use several CPU cores.

import type { GameResult, SimDeck } from '../engine/types';
import { playGame } from '../rules/session';
import { choosePod, type Pairing } from './pods';

export type WorkerRequest =
  | { type: 'start'; decks: SimDeck[]; podSize: number; maxRounds: number; seed: number; pairing: Pairing }
  | { type: 'stop' }
  | { type: 'sample'; decks: SimDeck[]; seed: number; maxRounds: number };

export type WorkerResponse =
  | { type: 'results'; results: GameResult[] }
  | { type: 'sample'; result: GameResult; log: string[] }
  | { type: 'error'; message: string };

let running = false;
let decks: SimDeck[] = [];
let podSize = 4;
let maxRounds = 40;
let seed = 1;
let pairing: Pairing = 'balanced';
const played = new Map<string, number>();

function post(msg: WorkerResponse) {
  (self as unknown as Worker).postMessage(msg);
}

function loop() {
  if (!running) return;
  const batch: GameResult[] = [];
  const start = performance.now();
  while (performance.now() - start < 200) {
    try {
      // A fresh random pod, in random seats, for every game.
      const pod = choosePod(decks, (d) => d.id, played, podSize, pairing);
      batch.push(playGame(pod, seed++, { maxRounds }).result);
    } catch (err) {
      post({ type: 'error', message: `Game with seed ${seed - 1} crashed: ${String(err)}` });
    }
  }
  post({ type: 'results', results: batch });
  setTimeout(loop, 0); // yield so "stop" messages get processed
}

self.onmessage = (ev: MessageEvent<WorkerRequest>) => {
  const msg = ev.data;
  switch (msg.type) {
    case 'start':
      decks = msg.decks;
      podSize = msg.podSize;
      maxRounds = msg.maxRounds;
      seed = msg.seed;
      pairing = msg.pairing;
      played.clear();
      if (!running) {
        running = true;
        loop();
      }
      break;
    case 'stop':
      running = false;
      break;
    case 'sample': {
      try {
        const { result, log } = playGame(msg.decks, msg.seed, { log: true, maxRounds: msg.maxRounds });
        post({ type: 'sample', result, log: log ?? [] });
      } catch (err) {
        post({ type: 'error', message: String(err) });
      }
      break;
    }
  }
};
