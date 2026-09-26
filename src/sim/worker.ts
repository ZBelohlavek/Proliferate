// Web Worker: plays games in a loop and posts results back in batches.
// Running in a worker keeps the page responsive, and several workers use
// several CPU cores.

import { playGame } from '../engine/game';
import type { GameResult, SimDeck } from '../engine/types';
import type { WorkerRequest, WorkerResponse } from './protocol';

let running = false;
let decks: SimDeck[] = [];
let podSize = 4;
let maxRounds = 25;
let seed = 1;
const played = new Map<string, number>();

function post(msg: WorkerResponse) {
  (self as unknown as Worker).postMessage(msg);
}

/** Pick the decks that have played least so far, so sample sizes stay even. */
function choosePod(): SimDeck[] {
  const shuffled = [...decks].sort(() => Math.random() - 0.5);
  shuffled.sort((a, b) => (played.get(a.id) ?? 0) - (played.get(b.id) ?? 0));
  const pod = shuffled.slice(0, Math.min(podSize, decks.length));
  for (const d of pod) played.set(d.id, (played.get(d.id) ?? 0) + 1);
  // Random seat order: going first matters.
  return pod.sort(() => Math.random() - 0.5);
}

function loop() {
  if (!running) return;
  const batch: GameResult[] = [];
  const start = performance.now();
  while (performance.now() - start < 200) {
    try {
      batch.push(playGame(choosePod(), seed++, { maxRounds }).result);
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
      const { result, log } = playGame(msg.decks, msg.seed, { log: true, maxRounds: msg.maxRounds });
      post({ type: 'sample', result, log: log ?? [] });
      break;
    }
  }
};
