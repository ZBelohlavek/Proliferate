// Web Worker: plays games in a loop and posts results back in batches.
// Running in a worker keeps the page responsive, and several workers use
// several CPU cores.

import { playGame } from '../engine/game';
import type { GameResult, SimDeck } from '../engine/types';
import { choosePod as pickPod, type Pairing } from './pods';
import type { Weights } from '../ai/playstyle';
import type { WorkerRequest, WorkerResponse } from './protocol';

let running = false;
let decks: SimDeck[] = [];
let podSize = 4;
let maxRounds = 25;
let seed = 1;
let playstyle: Weights | null = null;
let pairing: Pairing = 'balanced';
const played = new Map<string, number>();

function post(msg: WorkerResponse) {
  (self as unknown as Worker).postMessage(msg);
}

/** A fresh random pod for every game (see choosePod in pods.ts). */
function choosePod(): SimDeck[] {
  return pickPod(decks, (d) => d.id, played, podSize, pairing);
}

function loop() {
  if (!running) return;
  const batch: GameResult[] = [];
  const start = performance.now();
  while (performance.now() - start < 200) {
    try {
      batch.push(playGame(choosePod(), seed++, { maxRounds, playstyle }).result);
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
      playstyle = msg.playstyle;
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
      const { result, log } = playGame(msg.decks, msg.seed, { log: true, maxRounds: msg.maxRounds, playstyle: msg.playstyle });
      post({ type: 'sample', result, log: log ?? [] });
      break;
    }
  }
};
