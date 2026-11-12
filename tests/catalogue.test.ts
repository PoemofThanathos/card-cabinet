import { describe, expect, it, vi } from 'vitest';
import {
  catalogueIdentity,
  identityFingerprint,
  identitySchema,
  advanceIdentity,
  isCurrentLookup,
} from '../src/catalogue';
import { emptyFields } from '../src/model';
import {
  catalogueRequestSchema,
  callCatalogue,
  citedUrls,
  extractImage,
  safeUrl,
  sameIdentity,
} from '../worker/catalogue';
const identity = {
  name: 'Jacob Misiorowski',
  japaneseName: '',
  maker: 'Topps',
  set: 'Finest',
  year: '2026',
  cardNumber: 'TF-24',
  rarity: '',
};
describe('catalogue lookup safety', () => {
  it('sends only explicit public identity fields', () => {
    const fields = {
      ...emptyFields(),
      ...identity,
      notes: 'private',
      purchasePrice: '500',
      location: 'home',
    };
    const selected = catalogueIdentity(fields);
    expect(selected).toEqual(identity);
    expect(identitySchema.safeParse({ ...selected, notes: 'private' }).success).toBe(false);
    expect(
      catalogueRequestSchema.safeParse({
        task: 'catalogue',
        requestId: crypto.randomUUID(),
        identity: { ...selected, photos: ['private'] },
      }).success,
    ).toBe(false);
  });
  it('rejects mismatched player, year and number', () => {
    const card = {
      name: identity.name,
      japaneseName: '',
      maker: 'Topps',
      set: 'Finest',
      year: '2026',
      cardNumber: 'TF-24',
    };
    expect(sameIdentity(identity, card)).toBe(true);
    for (const change of [
      { name: 'Other Person' },
      { year: '2025' },
      { cardNumber: 'TF-25' },
      { cardNumber: '' },
      { maker: 'Panini' },
      { set: 'Topps Chrome' },
    ])
      expect(sameIdentity(identity, { ...card, ...change })).toBe(false);
  });
  it('uses only actual source and citation URLs', () => {
    const cited = citedUrls([
      { type: 'web_search_call', action: { sources: [{ url: 'https://example.com/card' }] } },
      {
        type: 'message',
        content: [{ annotations: [{ type: 'url_citation', url: 'https://example.org/card' }] }],
      },
    ]);
    expect(cited.has('https://example.com/card')).toBe(true);
    expect(cited.has('https://example.org/card')).toBe(true);
    expect(cited.has('https://invented.example/card')).toBe(false);
  });
  it('blocks unsafe URLs and never fetches unapproved or restricted hosts', async () => {
    for (const url of [
      'http://127.0.0.1',
      'https://localhost/',
      'https://user:pass@example.com',
      'https://192.168.1.1/',
      'https://[::1]/',
    ])
      expect(safeUrl(url)).toBeNull();
    const f = vi.fn();
    expect(await extractImage('https://tcdb.com/card', identity, f)).toBeNull();
    expect(await extractImage('https://topps.com.evil.example/card', identity, f)).toBeNull();
    expect(f).not.toHaveBeenCalled();
  });
  it('extracts only verified detail-page images and rejects generic metadata or redirects', async () => {
    const card = { ...identity, set: 'Topps All Aces', cardNumber: 'AA-5' };
    const page = 'https://www.cardcenteringtool.com/prices/pricecharting-11897391';
    const title = 'Jacob Misiorowski #AA-5 (Baseball Cards 2026 Topps All Aces)';
    const html = (image: string, alt = title) =>
      `<meta property="og:title" content="${title}"><meta property="og:image:alt" content="${alt}"><meta property="og:image" content="${image}">`;
    const img = 'https://i.ebayimg.com/images/g/NOQAAeSw04tqj5BK/s-l1600.jpg';
    const f = vi
      .fn()
      .mockResolvedValue(new Response(html(img), { headers: { 'Content-Type': 'text/html' } }));
    expect(await extractImage(page, card, f)).toBe(img);
    expect(await extractImage(page, { ...card, set: 'Topps Chrome' }, f)).toBeNull();
    expect(f.mock.calls[0][1].redirect).toBe('manual');
    f.mockResolvedValue(
      new Response(html('https://i.ebayimg.com/logo.jpg', 'Generic logo'), {
        headers: { 'Content-Type': 'text/html' },
      }),
    );
    expect(await extractImage(page, card, f)).toBeNull();
    f.mockResolvedValue(
      new Response(html(img, 'Different player 2026 Topps All Aces #AA-5'), {
        headers: { 'Content-Type': 'text/html' },
      }),
    );
    expect(await extractImage(page, card, f)).toBeNull();
    f.mockResolvedValue(
      new Response(null, { status: 302, headers: { Location: 'http://127.0.0.1' } }),
    );
    expect(await extractImage(page, card, f)).toBeNull();
    expect(await extractImage(page, { ...card, set: '' }, f)).toBeNull();
  });
  it('drops uncited and wrong-identity candidates from a model response', async () => {
    const base = {
      title: 'Card',
      sourceUrl: 'https://example.com/card',
      name: identity.name,
      japaneseName: '',
      maker: 'Topps',
      set: 'Finest',
      year: '2026',
      cardNumber: 'TF-24',
      exactness: 'exact',
    };
    const payload = {
      output: [
        { type: 'web_search_call', action: { sources: [{ url: 'https://example.com/card' }] } },
        {
          type: 'message',
          content: [
            {
              type: 'output_text',
              text: JSON.stringify({
                candidates: [
                  base,
                  { ...base, sourceUrl: 'https://invented.example/card' },
                  { ...base, cardNumber: 'TF-25' },
                ],
              }),
            },
          ],
        },
      ],
    };
    const stub = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    try {
      const result = await callCatalogue(identity, 'test-key');
      expect(result.candidates).toHaveLength(1);
      expect(result.candidates[0].sourceUrl).toBe(base.sourceUrl);
      expect(result.candidates[0].imageUrl).toBeNull();
    } finally {
      stub.mockRestore();
    }
  });
  it('marks incomplete identities unconfirmed', async () => {
    const candidate = {
      title: 'Card',
      sourceUrl: 'https://example.com/card',
      name: identity.name,
      japaneseName: '',
      maker: 'Topps',
      set: 'Finest',
      year: '2026',
      cardNumber: 'TF-24',
      exactness: 'exact',
    };
    const payload = {
      output: [
        { type: 'web_search_call', action: { sources: [{ url: candidate.sourceUrl }] } },
        {
          type: 'message',
          content: [{ type: 'output_text', text: JSON.stringify({ candidates: [candidate] }) }],
        },
      ],
    };
    const stub = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify(payload), { status: 200 }));
    try {
      expect(
        (await callCatalogue({ ...identity, cardNumber: '' }, 'test-key')).candidates[0].exactness,
      ).toBe('unconfirmed');
    } finally {
      stub.mockRestore();
    }
  });
  it('rejects a response after the identity changes even if it changes back', () => {
    let current = { fingerprint: 'A', generation: 0 };
    const started = current.generation;
    current = advanceIdentity(current, 'B');
    current = advanceIdentity(current, 'A');
    expect(isCurrentLookup(current, started)).toBe(false);
    expect(isCurrentLookup(current, current.generation)).toBe(true);
  });
  it('fingerprints change when card identity changes', () => {
    expect(identityFingerprint(identity)).not.toEqual(
      identityFingerprint({ ...identity, cardNumber: 'TF-25' }),
    );
  });
});
