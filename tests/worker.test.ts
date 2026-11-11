import { beforeAll, afterEach, describe, it, expect, vi } from 'vitest';
import { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT, type JWTVerifyGetKey } from 'jose';
import worker, {
  verifyIdentity,
  validateScan,
  validateImage,
  reserve,
  releaseReservation,
  limitedJson,
  callOpenAI,
  ScanGate,
  type Env,
} from '../worker/index';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import {
  aiModels,
  reasoningEfforts,
  aiRequestTimeoutMs,
  aiClientTimeoutMs,
  aiLeaseMs,
  outputTokenLimits,
} from '../src/ai-options';
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
const sqlDatabases: DatabaseSync[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const database of sqlDatabases.splice(0)) database.close();
});
function durableContext() {
  const database = new DatabaseSync(':memory:');
  sqlDatabases.push(database);
  let saved: ReturnType<typeof reserve>['state'] | undefined;
  let lock = Promise.resolve();
  const storage = {
    get: vi.fn(async () => structuredClone(saved)),
    put: vi.fn(async (_key: string, value: ReturnType<typeof reserve>['state']) => {
      saved = structuredClone(value);
    }),
    sql: {
      exec(query: string, ...bindings: string[]) {
        const rows = database.prepare(query).all(...bindings);
        return { toArray: () => rows };
      },
    },
  };
  const ctx = {
    storage,
    blockConcurrencyWhile: (fn: () => Promise<unknown>) => {
      const next = lock.then(fn);
      lock = next.then(
        () => {},
        () => {},
      );
      return next;
    },
  } as unknown as DurableObjectState;
  return { ctx, storage, saved: () => saved };
}
function scanRequest(
  requestId: string = crypto.randomUUID(),
  unlimited?: boolean,
  options: Record<string, unknown> = {},
) {
  return new Request('https://internal/identify', {
    method: 'POST',
    body: JSON.stringify({ requestId, images: [jpeg(), jpeg()], unlimited, ...options }),
  });
}
const completedResponse = () =>
  Response.json({
    status: 'completed',
    output: [
      {
        type: 'message',
        content: [{ type: 'output_text', text: '{"suggestions":[],"warnings":[]}' }],
      },
    ],
  });
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
  it('accepts the three processing speeds and rejects invalid speed overrides', () => {
    const request = { requestId: crypto.randomUUID(), images: [jpeg(), jpeg()] };
    for (const speed of ['normal', 'fast', 'ultra'])
      expect(validateScan({ ...request, speed }).speed).toBe(speed);
    expect(validateScan(request).speed).toBeUndefined();
    for (const speed of ['unlimited', 4, null, true, {}])
      expect(() => validateScan({ ...request, speed })).toThrow();
  });
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
        max_output_tokens: 999999,
      }),
    ).toThrow();
    expect(() => validateScan({ requestId: crypto.randomUUID(), images: [jpeg()] })).toThrow();
  });
  it('accepts explicit unlimited mode and rejects non-boolean overrides', () => {
    const scan = { requestId: crypto.randomUUID(), images: [jpeg(), jpeg()] };
    expect(validateScan(scan).unlimited).toBeUndefined();
    expect(validateScan({ ...scan, unlimited: true }).unlimited).toBe(true);
    expect(validateScan({ ...scan, unlimited: false }).unlimited).toBe(false);
    for (const unlimited of ['true', 1, null, {}])
      expect(() => validateScan({ ...scan, unlimited })).toThrow();
  });
  it.each([
    { model: 'unapproved-model' },
    { model: null },
    { model: 12 },
    { reasoningEffort: 'none' },
    { reasoningEffort: 'max' },
    { reasoningEffort: null },
    { reasoningEffort: true },
    { max_output_tokens: 999999 },
  ])(
    'rejects invalid model or reasoning options before reserving or calling OpenAI: %j',
    async (options) => {
      const value = { requestId: crypto.randomUUID(), images: [jpeg(), jpeg()], ...options };
      expect(() => validateScan(value)).toThrow();
      const { ctx, storage } = durableContext();
      const fetcher = vi.fn();
      vi.stubGlobal('fetch', fetcher);
      await expect(
        new ScanGate(ctx, env).fetch(scanRequest(crypto.randomUUID(), false, options)),
      ).rejects.toThrow();
      expect(storage.get).not.toHaveBeenCalled();
      expect(storage.put).not.toHaveBeenCalled();
      expect(fetcher).not.toHaveBeenCalled();
    },
  );
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
  it.each([
    ['fast', 2],
    ['ultra', 4],
  ] as const)(
    'allows %s speed to run %i concurrent requests without weakening replay protection',
    async (speed, concurrency) => {
      const { ctx, saved } = durableContext();
      const replies: ((value: Response) => void)[] = [];
      const fetcher = vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            replies.push(resolve);
          }),
      );
      vi.stubGlobal('fetch', fetcher);
      const gate = new ScanGate(ctx, env);
      const ids = Array.from({ length: concurrency }, () => crypto.randomUUID());
      const running = ids.map((id) => gate.fetch(scanRequest(id, true, { speed })));
      await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(concurrency));
      expect(saved()?.leases).toHaveLength(concurrency);
      expect((await gate.fetch(scanRequest(crypto.randomUUID(), true, { speed }))).status).toBe(
        429,
      );
      expect((await gate.fetch(scanRequest(ids[0], true, { speed }))).status).toBe(429);
      expect(saved()?.daily).toBe(concurrency);

      replies[1](completedResponse());
      expect((await running[1]).status).toBe(200);
      expect(saved()?.leases?.map((lease) => lease.id)).not.toContain(ids[1]);
      expect(saved()?.leases?.map((lease) => lease.id)).toContain(ids[0]);
      const extra = gate.fetch(scanRequest(crypto.randomUUID(), true, { speed }));
      await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(concurrency + 1));
      expect(saved()?.leases).toHaveLength(concurrency);
      expect((await gate.fetch(scanRequest(crypto.randomUUID(), true, { speed }))).status).toBe(
        429,
      );
      for (let index = 0; index < concurrency; index++)
        if (index !== 1) replies[index](completedResponse());
      replies[concurrency](completedResponse());
      expect((await extra).status).toBe(200);
      expect((await Promise.all(running)).every((response) => response.status === 200)).toBe(true);
      expect(saved()?.leases).toEqual([]);
      expect(saved()?.lease).toBeNull();
      expect(saved()?.daily).toBe(concurrency + 1);
      expect(
        (await new ScanGate(ctx, env).fetch(scanRequest(ids[0], true, { speed }))).status,
      ).toBe(429);
      expect(fetcher).toHaveBeenCalledTimes(concurrency + 1);
    },
  );

  it('keeps a Normal or Fast reservation restrictive when another request selects Ultra fast', () => {
    const now = Date.UTC(2026, 10, 11);
    const normal = reserve(undefined, 'normal', now, true).state;
    expect(reserve(normal, 'ultra', now + 20000, true, 'ultra').error).toContain('running');
    const first = reserve(undefined, 'fast-1', now, true, 'fast').state;
    const second = reserve(first, 'fast-2', now, true, 'fast').state;
    expect(reserve(second, 'ultra', now, true, 'ultra').error).toContain('running');
    const released = releaseReservation(second, 'fast-1', now);
    const added = reserve(released, 'ultra', now, true, 'ultra');
    expect(added.error).toBeUndefined();
    expect(reserve(added.state, 'extra', now, true, 'ultra').error).toContain('running');
    const complete = releaseReservation(
      releaseReservation(added.state, 'fast-2', now),
      'ultra',
      now,
    );
    expect(reserve(complete, 'normal-again', now + 1000, true).error).toContain('15 seconds');
  });

  it('migrates the old single lease and never releases a newer request when an expired one completes', () => {
    const now = Date.UTC(2026, 10, 11);
    const old = reserve(undefined, 'old', now, true).state;
    delete old.leases;
    expect(reserve(old, 'new', now + aiLeaseMs - 1, true, 'ultra').error).toContain('running');
    const replacement = reserve(old, 'new', now + aiLeaseMs, true, 'ultra').state;
    const released = releaseReservation(replacement, 'old', now + aiLeaseMs + 1);
    expect(released.leases?.map((lease) => lease.id)).toEqual(['new']);
    expect(released.lease).toBe('new');
  });

  it('keeps daily and monthly caps atomic across faster reservations', () => {
    const now = Date.UTC(2026, 10, 11, 12);
    const previous = reserve(undefined, 'old', now - 20000, true, 'ultra').state;
    previous.daily = 4;
    previous.monthly = 49;
    const fifth = reserve(releaseReservation(previous, 'old', now), 'fifth', now, false, 'ultra');
    expect(fifth.error).toBeUndefined();
    expect(fifth.state.daily).toBe(5);
    expect(fifth.state.monthly).toBe(50);
    const blocked = reserve(fifth.state, 'sixth', now, false, 'ultra');
    expect(blocked.error).toContain('limit');
    expect(blocked.state.daily).toBe(5);
    const uncapped = reserve(fifth.state, 'uncapped', now, true, 'ultra');
    expect(uncapped.error).toBeUndefined();
    expect(uncapped.state.daily).toBe(6);
  });
  it('keeps the reservation through the longer request window and releases expired leases', () => {
    const now = Date.UTC(2026, 10, 11);
    const first = reserve(undefined, crypto.randomUUID(), now).state;
    expect(first.leaseUntil).toBe(now + aiLeaseMs);
    expect(aiLeaseMs).toBeGreaterThan(aiClientTimeoutMs);
    expect(aiClientTimeoutMs).toBeGreaterThan(aiRequestTimeoutMs);
    expect(reserve(first, crypto.randomUUID(), now + aiLeaseMs - 1).error).toContain('running');
    expect(reserve(first, crypto.randomUUID(), now + aiLeaseMs).error).toBeUndefined();
  });
  it('enforces one in-flight scan, spacing and daily limits', () => {
    const now = Date.UTC(2026, 10, 9);
    const id = crypto.randomUUID();
    let result = reserve(undefined, id, now);
    expect(result.state.daily).toBe(1);
    expect(reserve(result.state, crypto.randomUUID(), now + 20000).error).toContain('running');
    result.state = releaseReservation(result.state, result.state.lease!, now);
    expect(reserve(result.state, crypto.randomUUID(), now + 1000).error).toContain('15 seconds');
    for (let n = 1; n < 5; n++) {
      result = reserve(
        { ...result.state, lease: null, leases: [] },
        crypto.randomUUID(),
        now + n * 20000,
      );
      expect(result.error).toBeUndefined();
    }
    expect(
      reserve({ ...result.state, lease: null, leases: [] }, crypto.randomUUID(), now + 200000)
        .error,
    ).toContain('limit');
  });
  it('unlimited mode bypasses count caps while retaining counts, spacing and the lease', () => {
    const now = Date.UTC(2026, 10, 10);
    const previous = reserve(undefined, crypto.randomUUID(), now).state;
    previous.daily = 5;
    previous.monthly = 50;
    expect(reserve(previous, crypto.randomUUID(), now + 20000, true).error).toContain('running');
    Object.assign(previous, releaseReservation(previous, previous.lease!, now));
    expect(reserve(previous, crypto.randomUUID(), now + 1000, true).error).toContain('15 seconds');
    const result = reserve(previous, crypto.randomUUID(), now + 20000, true);
    expect(result.error).toBeUndefined();
    expect(result.state.daily).toBe(6);
    expect(result.state.monthly).toBe(51);
    expect(
      reserve({ ...result.state, lease: null, leases: [] }, crypto.randomUUID(), now + 40000).error,
    ).toContain('limit');
  });
  it('keeps monthly limits across daily resets and resets on a new UTC month', () => {
    const now = Date.UTC(2026, 10, 9);
    const previous = reserve(undefined, crypto.randomUUID(), now).state;
    previous.monthly = 50;
    Object.assign(previous, releaseReservation(previous, previous.lease!, now));
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
    const { ctx, saved } = durableContext();
    let release!: () => void;
    const wait = new Promise<void>((r) => (release = r));
    const fetcher = vi.fn(async () => {
      await wait;
      return new Response('{}', { status: 500 });
    });
    vi.stubGlobal('fetch', fetcher);
    const gate = new ScanGate(ctx, env);
    const first = gate.fetch(scanRequest(crypto.randomUUID(), true));
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    expect((await gate.fetch(scanRequest(crypto.randomUUID(), true))).status).toBe(429);
    release();
    expect((await first).status).toBe(502);
    expect(saved()?.daily).toBe(1);
  });
  it('persists replay protection beyond 50 unlimited attempts and across object recreation', async () => {
    const { ctx, saved, storage } = durableContext();
    let now = Date.UTC(2026, 10, 10);
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const fetcher = vi.fn(async () => completedResponse());
    vi.stubGlobal('fetch', fetcher);
    const firstId = crypto.randomUUID();
    for (let i = 0; i < 55; i++) {
      const gate = new ScanGate(ctx, env);
      expect(
        (await gate.fetch(scanRequest(i === 0 ? firstId : crypto.randomUUID(), true))).status,
      ).toBe(200);
      now += 20000;
    }
    expect(saved()?.monthly).toBe(55);
    expect(storage.sql.exec('SELECT id FROM scan_requests').toArray()).toHaveLength(55);
    const restored = new ScanGate(ctx, env);
    const replay = await restored.fetch(scanRequest(firstId, true));
    expect(replay.status).toBe(429);
    expect(((await replay.json()) as { error: string }).error).toContain('already');
    expect((await restored.fetch(scanRequest())).status).toBe(429);
    expect((await restored.fetch(scanRequest(crypto.randomUUID(), false))).status).toBe(429);
    expect(fetcher).toHaveBeenCalledTimes(55);
  });
  it('retains failed request IDs without retrying their provider calls', async () => {
    const { ctx } = durableContext();
    const fetcher = vi.fn(async () => new Response('{}', { status: 500 }));
    vi.stubGlobal('fetch', fetcher);
    const id = crypto.randomUUID();
    expect((await new ScanGate(ctx, env).fetch(scanRequest(id, true))).status).toBe(502);
    expect((await new ScanGate(ctx, env).fetch(scanRequest(id, true))).status).toBe(429);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('clears replay rows at the next UTC month and resets the capped allowance', async () => {
    const { ctx, storage, saved } = durableContext();
    let now = Date.UTC(2026, 10, 30, 12);
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => completedResponse()),
    );
    expect(
      (await new ScanGate(ctx, env).fetch(scanRequest(crypto.randomUUID(), true))).status,
    ).toBe(200);
    now = Date.UTC(2026, 11, 1);
    expect((await new ScanGate(ctx, env).fetch(scanRequest())).status).toBe(200);
    expect(storage.sql.exec('SELECT id FROM scan_requests').toArray()).toHaveLength(1);
    expect(saved()?.monthly).toBe(1);
  });
  it.each(['sql', 'counter'])(
    'never calls the provider when %s persistence fails',
    async (failure) => {
      const { ctx, storage } = durableContext();
      const fetcher = vi.fn();
      vi.stubGlobal('fetch', fetcher);
      if (failure === 'sql')
        vi.spyOn(storage.sql, 'exec').mockImplementation(() => {
          throw new Error('Storage failed');
        });
      else storage.put.mockRejectedValue(new Error('Storage failed'));
      await expect(
        new ScanGate(ctx, env).fetch(scanRequest(crypto.randomUUID(), true)),
      ).rejects.toThrow('Storage failed');
      expect(fetcher).not.toHaveBeenCalled();
    },
  );
});
describe('mocked OpenAI structured outputs', () => {
  it('requires identity evidence before rejecting photographic backs or a one-sided serial', async () => {
    const fetcher = vi.fn(async (_url: unknown, _options?: RequestInit) => completedResponse());
    await callOpenAI(
      { requestId: crypto.randomUUID(), images: [jpeg(), jpeg()] },
      env,
      fetcher as typeof fetch,
    );
    const body = JSON.parse(fetcher.mock.calls[0][1]!.body as string);
    expect(body.instructions).toContain('A full-bleed photographic back can be a valid reverse');
    expect(body.instructions).toContain('small copyright/licensing text, card codes');
    expect(body.instructions).toContain('A serial printed on only one side');
    expect(body.instructions).toContain(
      'design/layout difference is not an identity contradiction',
    );
    expect(body.instructions).toContain(
      'Reject a pair only for clear contradictory identity or variant evidence',
    );
    expect(body.instructions).toContain('conflicting serials visible on both sides');
    expect(body.instructions).toContain('affirmative same-side evidence');
    expect(body.instructions).toContain(
      'Unknown side or incomplete identity evidence is uncertainty, not proof of a mismatch',
    );
    expect(body.instructions).toContain('Do not force a match');
    expect(body.input[0].content[0].text).toContain(
      'Report unresolved side or identity evidence as uncertainty',
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('sends release-year guidance and preserves copyright inference labels and warnings', async () => {
    const suggested = {
      suggestions: [
        {
          field: 'year',
          value: '2026',
          source: 'inference',
          evidence: 'Back copyright © 2026; product context supports this estimate.',
          uncertain: false,
        },
      ],
      warnings: ['Release year inferred from copyright; copyright and release years can differ.'],
    };
    const fetcher = vi.fn(async (_url: unknown, _options?: RequestInit) =>
      Response.json({
        status: 'completed',
        output: [
          {
            type: 'message',
            content: [{ type: 'output_text', text: JSON.stringify(suggested) }],
          },
        ],
      }),
    );
    const result = await callOpenAI(
      { requestId: crypto.randomUUID(), images: [jpeg(), jpeg()] },
      env,
      fetcher as typeof fetch,
    );
    expect(result).toEqual(suggested);
    const { instructions } = JSON.parse(fetcher.mock.calls[0][1]!.body as string);
    expect(instructions).toContain('Use an explicitly printed product/release year first');
    expect(instructions).toContain('copyright year may support a release-year inference');
    expect(instructions).toContain('copyright and release years can differ');
    expect(instructions).toContain('copyright-based release-year estimates use source=inference');
    expect(instructions).toContain("'2024 AL Leaders' labels a statistical season");
    expect(instructions).toContain('retro design year');
    expect(instructions).toContain('retain a known insert/subset title descriptively');
    expect(instructions).toContain('product family only when independently supported');
    expect(instructions).toContain('Do not infer a series number, parallel or base variant');
    expect(instructions).toContain('preserve the visible script');
    expect(instructions).toContain('return no suggestions and warn that the pair needs review');
    expect(instructions).toContain('Do not authenticate signatures');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each(
    aiModels.flatMap((model) =>
      reasoningEfforts.map((reasoningEffort) => ({ model, reasoningEffort })),
    ),
  )(
    'forwards $model with $reasoningEffort reasoning and its output budget',
    async ({ model, reasoningEffort }) => {
      const { ctx } = durableContext();
      const fetcher = vi.fn(async (_url: unknown, _options?: RequestInit) => completedResponse());
      vi.stubGlobal('fetch', fetcher);
      const timeout = vi.spyOn(AbortSignal, 'timeout');
      const options = { model, reasoningEffort };
      const validated = validateScan({
        requestId: crypto.randomUUID(),
        images: [jpeg(), jpeg()],
        ...options,
      });
      expect(validated).toMatchObject(options);
      expect(
        (await new ScanGate(ctx, env).fetch(scanRequest(validated.requestId, false, options)))
          .status,
      ).toBe(200);
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(fetcher.mock.calls[0][0]).toBe('https://api.openai.com/v1/responses');
      const body = JSON.parse(fetcher.mock.calls[0][1]!.body as string);
      expect(body.model).toBe(model);
      expect(body.reasoning).toEqual({ effort: reasoningEffort });
      expect(body.max_output_tokens).toBe(outputTokenLimits[reasoningEffort]);
      expect(body.store).toBe(false);
      expect(body.text.format.strict).toBe(true);
      expect(
        body.input[0].content.filter((item: { type: string }) => item.type === 'input_image'),
      ).toHaveLength(2);
      expect(timeout).toHaveBeenCalledWith(aiRequestTimeoutMs);
    },
  );
  it('uses the server model and low reasoning for legacy requests without weakening replay protection', async () => {
    const { ctx } = durableContext();
    const fetcher = vi.fn(async (_url: unknown, _options?: RequestInit) => completedResponse());
    vi.stubGlobal('fetch', fetcher);
    const id = crypto.randomUUID();
    const gate = new ScanGate(ctx, { ...env, OPENAI_MODEL: 'gpt-6.1-terra' });
    expect((await gate.fetch(scanRequest(id))).status).toBe(200);
    const body = JSON.parse(fetcher.mock.calls[0][1]!.body as string);
    expect(body.model).toBe('gpt-6.1-terra');
    expect(body.reasoning).toEqual({ effort: 'low' });
    expect(body.max_output_tokens).toBe(outputTokenLimits.low);
    expect((await gate.fetch(scanRequest(id))).status).toBe(429);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
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
