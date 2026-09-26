// Vercel serverless function: GET /api/archidekt?id=123
// Same job as the middleware in vite.config.ts, for deployed builds.
export default async function handler(req, res) {
  const id = String(req.query.id ?? '');
  if (!/^\d+$/.test(id)) {
    res.status(400).json({ error: 'Deck id must be numeric' });
    return;
  }
  try {
    const upstream = await fetch(`https://archidekt.com/api/decks/${id}/`, {
      headers: { Accept: 'application/json', 'User-Agent': 'Proliferate-EDH-Sim/0.1' },
    });
    res.status(upstream.status).setHeader('Content-Type', 'application/json');
    res.send(await upstream.text());
  } catch (err) {
    res.status(502).json({ error: String(err) });
  }
}
