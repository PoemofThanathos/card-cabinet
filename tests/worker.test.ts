import { beforeAll, afterEach, describe, it, expect, vi } from 'vitest';
import { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT, type JWTVerifyGetKey } from 'jose';
import worker, {
  verifyIdentity,
  validateScan,
  validateImage,
  reserve,
  limitedJson,
  callOpenAI,
  ScanGate,
  type Env,
} from '../worker/index';
import { readFileSync } from 'node:fs';
let privateKey: CryptoKey, keys: JWTVerifyGetKey;
const env = {
  FIREBASE_PROJECT_ID: 'test-project',
  OWNER_UID: 'owner',
  ALLOWED_ORIGIN: 'https://example.github.io',
  OPENAI_MODEL: 'gpt-6-luna',
  AI_ENABLED: 'true',
  OPENAI_API_KEY: 'test-not-a-real-key',
} as Env;
beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  privateKey = pair.privateKey;
  const jwk = await exportJWK(pair.publicKey);
  keys = createLocalJWKSet({ keys: [{ ...jwk, kid: 'test', alg: 'RS256', use: 'sig' }] });
});
afterEach(() => vi.unstubAllGlobals());
async function token(changes: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    sub: 'owner',
    iss: 'https://securetoken.google.com/test-project',
    aud: 'test-project',
    exp: now + 3600,
    iat: now - 10,
    auth_time: now - 100,
    ...changes,
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'test' })
    .sign(privateKey);
}
const jpeg = () =>
  'data:image/jpeg;base64,' +
  readFileSync(new URL('./fixtures/card.jpg', import.meta.url)).toString('base64');
describe('Firebase token verification', () => {
  it('accepts a valid signed owner token', async () =>
    expect(await verifyIdentity(await token(), env, keys)).toBe('owner'));
  it.each([
    { sub: 'other' },
    { iss: 'wrong' },
    { aud: 'other-project' },
    { exp: 1 },
    { iat: 9999999999 },
    { auth_time: 9999999999 },
    { sub: '' },
  ])('rejects altered claims %j', async (claims) => {
    await expect(verifyIdentity(await token(claims), env, keys)).rejects.toThrow();
  });
  it('rejects an invalid signature', async () => {
    const valid = await token();
    const parts = valid.split('.');
    parts[2] = (parts[2][0] === 'A' ? 'B' : 'A') + parts[2].slice(1);
    await expect(verifyIdentity(parts.join('.'), env, keys)).rejects.toThrow();
  });
});
describe('Worker request boundaries', () => {
  it('accepts exactly two clean JPEGs', () => {
    expect(
      validateScan({ requestId: crypto.randomUUID(), images: [jpeg(), jpeg()] }).images,
    ).toHaveLength(2);
  });
  it.each([
    'https://example.com/photo.jpg',
    'data:image/png;base64,aGVsbG8=',
    'data:image/jpeg;base64,AAAA',
  ])('rejects malformed or arbitrary URL input', (data) =>
    expect(() => validateImage(data)).toThrow(),
  );
  it('rejects extra request fields and incomplete image pairs', () => {
    expect(() =>
      validateScan({
        requestId: crypto.randomUUID(),
        images: [jpeg(), jpeg()],
        model: 'expensive',
      }),
    ).toThrow();
    expect(() => validateScan({ requestId: crypto.randomUUID(), images: [jpeg()] })).toThrow();
  });
  it('rejects EXIF metadata and oversized dimensions', () => {
    const bytes = readFileSync(new URL('./fixtures/card.jpg', import.meta.url));
    const exif = Buffer.concat([
      bytes.subarray(0, 2),
      Buffer.from([255, 225, 0, 8, 69, 120, 105, 102, 0, 0]),
      bytes.subarray(2),
    ]);
    expect(() => validateImage('data:image/jpeg;base64,' + exif.toString('base64'))).toThrow(
      'EXIF',
    );
    const huge = Buffer.from(bytes);
    const pos = huge.indexOf(Buffer.from([255, 192]));
    huge[pos + 5] = 0x7f;
    huge[pos + 6] = 0xff;
    expect(() => validateImage('data:image/jpeg;base64,' + huge.toString('base64'))).toThrow(
      'dimensions',
    );
  });
  it('limits bodies without trusting Content-Length', async () => {
    const req = new Request('https://x', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '123456789',
    });
    await expect(limitedJson(req, 4)).rejects.toThrow('large');
  });
  it('rejects unknown origins, missing authorization, and an off switch', async () => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    const req = (origin: string) =>
      new Request('https://worker/identify', { method: 'POST', headers: { Origin: origin } });
    expect((await worker.fetch(req('https://evil.example'), env)).status).toBe(403);
    expect((await worker.fetch(req(env.ALLOWED_ORIGIN), env)).status).toBe(401);
    expect(
      (await worker.fetch(req(env.ALLOWED_ORIGIN), { ...env, AI_ENABLED: 'false' })).status,
    ).toBe(503);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
describe('durable usage limits', () => {
  it('enforces one in-flight scan, replay prevention, spacing and daily limits', () => {
    const now = Date.UTC(2026, 10, 9);
    const id = crypto.randomUUID();
    let result = reserve(undefined, id, now);
    expect(result.state.daily).toBe(1);
    expect(reserve(result.state, crypto.randomUUID(), now + 20000).error).toContain('running');
    result.state.lease = null;
    expect(reserve(result.state, id, now + 20000).error).toContain('already');
    expect(reserve(result.state, crypto.randomUUID(), now + 1000).error).toContain('15 seconds');
    for (let n = 1; n < 5; n++) {
      result = reserve({ ...result.state, lease: null }, crypto.randomUUID(), now + n * 20000);
      expect(result.error).toBeUndefined();
    }
    expect(
      reserve({ ...result.state, lease: null }, crypto.randomUUID(), now + 200000).error,
    ).toContain('limit');
  });
  it('keeps monthly limits across daily resets and resets on a new UTC month', () => {
    const now = Date.UTC(2026, 10, 9);
    const previous = reserve(undefined, crypto.randomUUID(), now).state;
    previous.monthly = 50;
    previous.lease = null;
    expect(reserve(previous, crypto.randomUUID(), now + 86400000).error).toContain('limit');
    expect(reserve(previous, crypto.randomUUID(), Date.UTC(2026, 11, 1)).error).toBeUndefined();
  });
  it('fails closed when durable storage is unavailable', async () => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    const ctx = {
      blockConcurrencyWhile: async (fn: () => Promise<unknown>) => fn(),
      storage: {
        get: async () => {
          throw new Error('Unavailable');
        },
      },
    } as unknown as DurableObjectState;
    const gate = new ScanGate(ctx, env);
    await expect(
      gate.fetch(
        new Request('https://internal', {
          method: 'POST',
          body: JSON.stringify({ requestId: crypto.randomUUID(), images: [jpeg(), jpeg()] }),
        }),
      ),
    ).rejects.toThrow('Unavailable');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('serializes reservations for concurrent requests and counts failed calls', async () => {
    let saved: unknown;
    let lock = Promise.resolve();
    const storage = {
      get: async () => structuredClone(saved),
      put: async (_k: string, v: unknown) => {
        saved = structuredClone(v);
      },
    };
    const ctx = {
      storage,
      blockConcurrencyWhile: (fn: () => Promise<unknown>) => {
        const next = lock.then(fn);
        lock = next.then(() => {});
        return next;
      },
    } as unknown as DurableObjectState;
    let release!: () => void;
    const wait = new Promise<void>((r) => (release = r));
    const fetcher = vi.fn(async () => {
      await wait;
      return new Response('{}', { status: 500 });
    });
    vi.stubGlobal('fetch', fetcher);
    const gate = new ScanGate(ctx, env);
    const req = () =>
      new Request('https://internal', {
        method: 'POST',
        body: JSON.stringify({ requestId: crypto.randomUUID(), images: [jpeg(), jpeg()] }),
      });
    const first = gate.fetch(req());
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    expect((await gate.fetch(req())).status).toBe(429);
    release();
    expect((await first).status).toBe(502);
    expect((saved as { daily: number }).daily).toBe(1);
  });
});
describe('mocked OpenAI structured outputs', () => {
  it('uses the server model, both images, strict schema and no storage', async () => {
    const fetcher = vi.fn(async (_url: unknown, _options?: RequestInit) =>
      Response.json({
        status: 'completed',
        output: [
          {
            type: 'message',
            content: [
              {
                type: 'output_text',
                text: JSON.stringify({
                  suggestions: [
                    {
                      field: 'year',
                      value: '2020',
                      source: 'inference',
                      evidence: 'Illegible print',
                      uncertain: true,
                    },
                  ],
                  warnings: [],
                }),
              },
            ],
          },
        ],
      }),
    );
    const result = await callOpenAI(
      { requestId: crypto.randomUUID(), images: [jpeg(), jpeg()] },
      env,
      fetcher as typeof fetch,
    );
    const body = JSON.parse(fetcher.mock.calls[0][1]!.body as string);
    expect(body.model).toBe(env.OPENAI_MODEL);
    expect(body.store).toBe(false);
    expect(body.text.format.strict).toBe(true);
    expect(
      body.input[0].content.filter((c: { type: string }) => c.type === 'input_image'),
    ).toHaveLength(2);
    expect(result.suggestions[0].value).toBe('');
  });
  it('rejects refusals and incomplete responses without retrying', async () => {
    const fetcher = vi.fn(async () => Response.json({ status: 'incomplete' }));
    await expect(
      callOpenAI(
        { requestId: crypto.randomUUID(), images: [jpeg(), jpeg()] },
        env,
        fetcher as typeof fetch,
      ),
    ).rejects.toThrow('incomplete');
    expect(fetcher).toHaveBeenCalledTimes(1);
    const refusal = vi.fn(async () =>
      Response.json({
        status: 'completed',
        output: [{ type: 'message', content: [{ type: 'refusal' }] }],
      }),
    );
    await expect(
      callOpenAI(
        { requestId: crypto.randomUUID(), images: [jpeg(), jpeg()] },
        env,
        refusal as typeof fetch,
      ),
    ).rejects.toThrow('declined');
  });
});
