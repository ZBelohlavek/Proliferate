// Vite plugin exposing the Forge runner over HTTP:
//
//   GET  /api/forge/status
//   POST /api/forge/check    { decks }                  -> cards Forge doesn't know
//   POST /api/forge/start    { decks, podSize, workers, clockSeconds, heapMb }
//   POST /api/forge/stop
//   GET  /api/forge/results?since=N
//   GET  /api/forge/log?index=N   (-1 = latest game)

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import { ForgeRunner } from './forgeRunner.ts';
import { sanitizePodSize } from '../src/sim/pods.ts';

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function send(res: ServerResponse, status: number, data: unknown) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(data));
}

export function forgePlugin(projectRoot: string): Plugin {
  let runner: ForgeRunner | null = null;
  const getRunner = () => {
    if (!runner) {
      runner = new ForgeRunner(projectRoot);
      // Child processes can outlive us on Windows; take them down with the server.
      const r = runner;
      process.once('exit', () => r.stop());
      for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { r.stop(); process.exit(); });
    }
    return runner;
  };

  async function handle(req: IncomingMessage, res: ServerResponse, next: () => void) {
    const url = new URL(req.url ?? '', 'http://localhost');
    if (!url.pathname.startsWith('/api/forge/')) return next();
    const r = getRunner();
    try {
      switch (url.pathname) {
        case '/api/forge/status':
          return send(res, 200, r.status());
        case '/api/forge/check': {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const body = (await readBody(req)) as any;
          return send(res, 200, r.check(body.decks ?? []));
        }
        case '/api/forge/start': {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const body = (await readBody(req)) as any;
          const clamp = (v: unknown, lo: number, hi: number, d: number) => Math.min(hi, Math.max(lo, Number(v) || d));
          return send(res, 200, r.start({
            decks: body.decks ?? [],
            podSize: sanitizePodSize(body.podSize), // 2–6, or 0 = mixed sizes
            pairing: body.pairing === 'random' ? 'random' : 'balanced',
            gamesPerLaunch: clamp(body.gamesPerLaunch, 1, 5, 2),
            aiProfile: ['Default', 'Cautious', 'Reckless', 'Experimental', 'You', 'Mixed'].includes(body.aiProfile) ? body.aiProfile : 'Default',
            profileOverrides: body.profileOverrides && typeof body.profileOverrides === 'object' ? body.profileOverrides : null,
            stopAt: Number.isFinite(Number(body.stopAt)) && Number(body.stopAt) > 0 ? Number(body.stopAt) : null,
            maxGames: Number.isInteger(Number(body.maxGames)) && Number(body.maxGames) > 0 ? Number(body.maxGames) : null,
            workers: clamp(body.workers, 1, 32, 4),
            clockSeconds: clamp(body.clockSeconds, 60, 3600, 600),
            heapMb: clamp(body.heapMb, 1024, 16384, 3072),
          }));
        }
        case '/api/forge/stop':
          r.stop();
          return send(res, 200, { ok: true });
        case '/api/forge/results':
          return send(res, 200, r.results(Number(url.searchParams.get('since')) || 0));
        case '/api/forge/log': {
          const log = r.gameLog(Number(url.searchParams.get('index') ?? -1));
          return log ? send(res, 200, log) : send(res, 404, { error: 'No games yet' });
        }
        default:
          return send(res, 404, { error: 'Unknown endpoint' });
      }
    } catch (err) {
      return send(res, 500, { error: (err as Error).message });
    }
  }

  return {
    name: 'forge-runner',
    configureServer(server) {
      server.middlewares.use(handle);
      server.httpServer?.on('close', () => runner?.stop());
    },
    configurePreviewServer(server) {
      server.middlewares.use(handle);
      server.httpServer?.on('close', () => runner?.stop());
    },
  };
}
