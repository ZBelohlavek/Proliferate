import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import type { IncomingMessage, ServerResponse } from 'node:http';

// Archidekt's API only sends CORS headers for its own site, so the browser
// can't call it directly. This middleware forwards /api/archidekt?id=123 to
// Archidekt from the dev/preview server. api/archidekt.js does the same job
// when the site is deployed to Vercel.
async function archidektProxy(req: IncomingMessage, res: ServerResponse, next: () => void) {
  const url = new URL(req.url ?? '', 'http://localhost');
  if (url.pathname !== '/api/archidekt') return next();
  const id = url.searchParams.get('id') ?? '';
  if (!/^\d+$/.test(id)) {
    res.statusCode = 400;
    res.end(JSON.stringify({ error: 'Deck id must be numeric' }));
    return;
  }
  try {
    const upstream = await fetch(`https://archidekt.com/api/decks/${id}/`, {
      headers: { Accept: 'application/json', 'User-Agent': 'Proliferate-EDH-Sim/0.1' },
    });
    res.statusCode = upstream.status;
    res.setHeader('Content-Type', 'application/json');
    res.end(await upstream.text());
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
  plugins: [react(), archidekt],
  worker: { format: 'es' },
});
