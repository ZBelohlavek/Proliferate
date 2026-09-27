import { afterEach, describe, expect, it, vi } from 'vitest';
import { archidektRequest } from '../api/_archidekt.js';

afterEach(() => vi.unstubAllGlobals());

const reply = (data: unknown) => new Response(JSON.stringify(data), { status: 200 });

describe('Archidekt proxy', () => {
  it('rejects bad input before calling Archidekt', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    expect((await archidektRequest(new URLSearchParams('id=12a'))).status).toBe(400);
    expect((await archidektRequest(new URLSearchParams('user=bad name'))).status).toBe(400);
    expect((await archidektRequest(new URLSearchParams(''))).status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("follows pages and keeps only that exact user's decks", async () => {
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(reply({
        next: 'http://archidekt.com/api/decks/v3/?ownerUsername=Zach&page=2',
        results: [{ id: 1, owner: { username: 'Zach' } }, { id: 2, owner: { username: 'Zachary99' } }],
      }))
      .mockResolvedValueOnce(reply({ next: null, results: [{ id: 3, owner: { username: 'zach' } }] }));
    vi.stubGlobal('fetch', fetchSpy);

    const { status, body } = await archidektRequest(new URLSearchParams('user=Zach'));
    expect(status).toBe(200);
    expect(JSON.parse(body).results.map((d: { id: number }) => d.id)).toEqual([1, 3]);
    expect(fetchSpy.mock.calls[1][0]).toMatch(/^https:/); // next-page link upgraded to https
  });
});
