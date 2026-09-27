import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import { forgePlugin } from './server/forgePlugin.ts';
import { archidektRequest } from './api/_archidekt.js';

// Archidekt only allows its own site to call its API from a browser, so the
// page calls /api/archidekt?id=… or ?user=… and this middleware forwards it
// (logic shared with the Vercel function in api/archidekt.js).
async function archidektProxy(req: IncomingMessage, res: ServerResponse, next: () => void) {
  const url = new URL(req.url ?? '', 'http://localhost');
  if (url.pathname !== '/api/archidekt') return next();
  try {
    const { status, body } = await archidektRequest(url.searchParams);
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json');
    res.end(body);
  } catch (err) {
    res.statusCode = 502;
    res.end(JSON.stringify({ error: String(err) }));
  }
}

const archidekt: Plugin = {
  name: 'archidekt-proxy',
  configureServer(server) {
    server.middlewares.use(archidektProxy);
  },
  configurePreviewServer(server) {
    server.middlewares.use(archidektProxy);
  },
};

export default defineConfig({
  plugins: [react(), archidekt, forgePlugin(fileURLToPath(new URL('.', import.meta.url)))],
  worker: { format: 'es' },
});
