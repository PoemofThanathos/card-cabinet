import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db, setSetting, setting } from '../src/db';
import { newCard, type Card } from '../src/model';
import { identify } from '../src/ai';
import { transmittedPhoto } from '../src/photos';

const identity = vi.hoisted(() => ({ getIdToken: vi.fn() }));
vi.mock('../src/firebase', () => ({ auth: { currentUser: identity } }));
vi.mock('../src/photos', () => ({ transmittedPhoto: vi.fn() }));

let card: Card;
let fetcher: ReturnType<typeof vi.fn>;
const day = () => new Date().toISOString().slice(0, 10);
beforeEach(async () => {
  await db.delete();
  await db.open();
  await setSetting('aiEnabled', true);
  await setSetting('aiLimit', 3);
  card = newCard();
  card.photos = { front: 'a'.repeat(64), back: 'b'.repeat(64) };
  await db.photos.bulkPut(
    Object.values(card.photos).map((hash) => ({
      hash: hash!,
      bytes: new Uint8Array([1, 2, 3]).buffer,
      type: 'image/jpeg',
      size: 3,
    })),
  );
  identity.getIdToken.mockReset().mockResolvedValue('test-token');
  vi.mocked(transmittedPhoto).mockReset().mockResolvedValue('data:image/jpeg;base64,test-fixture');
  fetcher = vi.fn(async () => Response.json({ suggestions: [], warnings: [] }));
  vi.stubGlobal('fetch', fetcher);
  vi.stubEnv('VITE_WORKER_URL', 'https://worker.example');
});
afterEach(async () => {
  await db.delete();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('identification allowance', () => {
  it('keeps identification off until enabled, even with unlimited attempts selected', async () => {
    await setSetting('aiEnabled', false);
    await setSetting('aiUnlimited', true);
    await expect(identify(card)).rejects.toThrow('Enable identification');
    expect(fetcher).not.toHaveBeenCalled();
    expect(await setting('aiUsage', null)).toBeNull();
  });

  it('uses the daily device cap when unlimited has not been enabled', async () => {
    await setSetting('aiUsage', { day: day(), count: 3 });
    await expect(identify(card)).rejects.toThrow('daily scan limit');
    expect(fetcher).not.toHaveBeenCalled();
    expect(transmittedPhoto).not.toHaveBeenCalled();
  });

  it('sends the capped mode explicitly for normal requests', async () => {
    await identify(card);
    const [url, options] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(options.body as string);
    expect(url).toBe('https://worker.example/identify');
    expect(body.unlimited).toBe(false);
    expect(body.images).toHaveLength(2);
    expect(options.headers).toMatchObject({ Authorization: 'Bearer test-token' });
    expect(await setting('aiUsage', { day: '', count: 0 })).toEqual({ day: day(), count: 1 });
  });

  it('allows scans beyond the count cap only when unlimited is on and keeps counting', async () => {
    await setSetting('aiUnlimited', true);
    await setSetting('aiUsage', { day: day(), count: 75 });
    await identify(card);
    const [, options] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(options.body as string).unlimited).toBe(true);
    expect(await setting('aiUsage', { day: '', count: 0 })).toEqual({ day: day(), count: 76 });
    await setSetting('aiUnlimited', false);
    await expect(identify(card)).rejects.toThrow('daily scan limit');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('rechecks a switched-off unlimited mode after preparing photos', async () => {
    await setSetting('aiUnlimited', true);
    await setSetting('aiUsage', { day: day(), count: 75 });
    identity.getIdToken.mockImplementation(async () => {
      await setSetting('aiUnlimited', false);
      return 'test-token';
    });
    await expect(identify(card)).rejects.toThrow('daily scan limit');
    expect(fetcher).not.toHaveBeenCalled();
    expect((await setting('aiUsage', { day: '', count: 0 })).count).toBe(75);
  });

  it('rechecks the identification switch and current cap before reserving a request', async () => {
    identity.getIdToken.mockImplementation(async () => {
      await setSetting('aiEnabled', false);
      return 'test-token';
    });
    await expect(identify(card)).rejects.toThrow('Enable identification');
    expect(fetcher).not.toHaveBeenCalled();
    await setSetting('aiEnabled', true);
    await setSetting('aiUsage', { day: day(), count: 1 });
    identity.getIdToken.mockImplementation(async () => {
      await setSetting('aiLimit', 1);
      return 'test-token';
    });
    await expect(identify(card)).rejects.toThrow('daily scan limit');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('reserves the last allowed attempt once across concurrent callers', async () => {
    await setSetting('aiUsage', { day: day(), count: 2 });
    const results = await Promise.allSettled([identify(card), identify(card)]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect((await setting('aiUsage', { day: '', count: 0 })).count).toBe(3);
  });

  it('counts failed and ambiguous unlimited attempts without automatic retries', async () => {
    await setSetting('aiUnlimited', true);
    fetcher.mockResolvedValueOnce(
      Response.json({ error: 'Provider unavailable.' }, { status: 502 }),
    );
    await expect(identify(card)).rejects.toThrow('Provider unavailable');
    expect(fetcher).toHaveBeenCalledTimes(1);
    fetcher.mockRejectedValueOnce(new Error('Connection lost'));
    await expect(identify(card)).rejects.toThrow('Connection lost');
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect((await setting('aiUsage', { day: '', count: 0 })).count).toBe(2);
  });

  it.each([
    { status: 500, body: '<html>Worker CPU limit exceeded</html>', message: 'HTTP 500' },
    { status: 429, body: '', message: 'HTTP 429' },
    {
      status: 200,
      body: '<html>Unexpected gateway response</html>',
      message: 'unreadable response',
    },
  ])(
    'explains an unreadable HTTP $status response without retrying or refunding the attempt',
    async ({ status, body, message }) => {
      await setSetting('aiUnlimited', true);
      fetcher.mockResolvedValueOnce(
        new Response(body, {
          status,
          headers: { 'Content-Type': 'text/html' },
        }),
      );
      const error = await identify(card).then(
        () => null,
        (failure: unknown) => failure,
      );
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(SyntaxError);
      expect((error as Error).message).toContain(message);
      expect((error as Error).message).toContain('may have been billed');
      expect((error as Error).message).toContain('No automatic retry');
      expect((error as Error).message).not.toContain('<html>');
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect((await setting('aiUsage', { day: '', count: 0 })).count).toBe(1);
    },
  );

  it('does not send a request or consume an allowance when a photo is missing', async () => {
    await setSetting('aiUnlimited', true);
    await db.photos.delete(card.photos.back!);
    await expect(identify(card)).rejects.toThrow('Both photos');
    expect(fetcher).not.toHaveBeenCalled();
    expect(await setting('aiUsage', null)).toBeNull();
  });
});
