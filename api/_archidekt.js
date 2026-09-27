// Shared Archidekt proxy logic, used by the Vite dev server (vite.config.ts)
// and the Vercel function (api/archidekt.js). Files starting with "_" are
// not routes on Vercel.
//
// Archidekt's API only allows its own website to call it from a browser,
// so the page asks this proxy instead:
//   ?id=123           one deck
//   ?user=SomeName    a user's public decks (all pages)

const HEADERS = { Accept: 'application/json', 'User-Agent': 'Proliferate-EDH-Sim/0.1' };

/** @returns {Promise<{ status: number, body: string }>} */
export async function archidektRequest(params) {
  const id = params.get('id');
  const user = params.get('user');

  if (id !== null) {
    if (!/^\d+$/.test(id)) return json(400, { error: 'Deck id must be numeric' });
    const upstream = await fetch(`https://archidekt.com/api/decks/${id}/`, { headers: HEADERS });
    return { status: upstream.status, body: await upstream.text() };
  }

  if (user !== null) {
    if (!/^[\w.@+-]{1,64}$/.test(user)) return json(400, { error: 'That is not a valid Archidekt username' });
    const results = [];
    let url = `https://archidekt.com/api/decks/v3/?ownerUsername=${encodeURIComponent(user)}`;
    for (let page = 0; url && page < 20; page++) {
      const upstream = await fetch(url, { headers: HEADERS });
      if (!upstream.ok) return { status: upstream.status, body: await upstream.text() };
      const data = await upstream.json();
      results.push(...(data.results ?? []));
      // Archidekt returns http:// links for the next page; keep it on https.
      url = data.next ? String(data.next).replace(/^http:/, 'https:') : null;
    }
    // The search matches usernames loosely; keep only this exact user's decks.
    const own = results.filter((d) => d.owner?.username?.toLowerCase() === user.toLowerCase());
    return json(200, { count: own.length, results: own });
  }

  return json(400, { error: 'Pass ?id=<deck id> or ?user=<username>' });
}

function json(status, data) {
  return { status, body: JSON.stringify(data) };
}
