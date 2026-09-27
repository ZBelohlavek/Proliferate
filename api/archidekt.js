// Vercel serverless function: GET /api/archidekt?id=123 or ?user=Name
// Same job as the middleware in vite.config.ts, for deployed builds.
import { archidektRequest } from './_archidekt.js';

export default async function handler(req, res) {
  try {
    const params = new URLSearchParams();
    for (const key of ['id', 'user']) if (req.query[key] !== undefined) params.set(key, String(req.query[key]));
    const { status, body } = await archidektRequest(params);
    res.status(status).setHeader('Content-Type', 'application/json');
    res.send(body);
  } catch (err) {
    res.status(502).json({ error: String(err) });
  }
}
