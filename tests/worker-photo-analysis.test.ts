import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import worker, {
  callOpenAI,
  ScanGate,
  validateScan,
  type Env,
  type PhotoAnalysisRequest,
} from '../worker/index';
import { photoAnalysisOutputSchema, type PhotoAnalysis } from '../src/photo-analysis';
import { outputTokenLimits } from '../src/ai-options';

const env = {
  FIREBASE_PROJECT_ID: 'test-project',
  OWNER_UID: 'owner',
  ALLOWED_ORIGIN: 'https://example.github.io',
  OPENAI_MODEL: 'gpt-6-luna',
  AI_ENABLED: 'true',
  OPENAI_API_KEY: 'test-not-a-real-key',
} as Env;
const databases: DatabaseSync[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const database of databases.splice(0)) database.close();
});
function images() {
  const jpeg = readFileSync(new URL('./fixtures/card.jpg', import.meta.url));
  const other = Buffer.concat([
    jpeg.subarray(0, 2),
    Buffer.from([255, 254, 0, 6, 116, 101, 115, 116]),
    jpeg.subarray(2),
  ]);
  return [jpeg, other].map((image) => 'data:image/jpeg;base64,' + image.toString('base64'));
}
function scan(count = 2): PhotoAnalysisRequest {
  return {
    requestId: crypto.randomUUID(),
    task: 'analyze_photos',
    images: images().slice(0, count),
  };
}
function photo(overrides: Partial<PhotoAnalysis> = {}): PhotoAnalysis {
  return {
    side: 'unknown',
    name: '',
    maker: '',
    set: '',
    year: '',
    cardNumber: '',
    variant: '',
    serial: '',
    evidence: 'The layout is not clear.',
    warnings: ['Identity cannot be read.'],
    ...overrides,
  };
}
function provider(result: unknown) {
  return Response.json({
    status: 'completed',
    output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(result) }] }],
  });
}
function context() {
  const database = new DatabaseSync(':memory:');
  databases.push(database);
  let state: unknown;
  const storage = {
    get: async () => structuredClone(state),
    put: async (_key: string, value: unknown) => {
      state = structuredClone(value);
    },
    sql: {
      exec(query: string, ...args: string[]) {
        const rows = database.prepare(query).all(...args);
        return { toArray: () => rows };
      },
    },
  };
  const ctx = {
    storage,
    blockConcurrencyWhile: async (action: () => Promise<unknown>) => action(),
  } as unknown as DurableObjectState;
  return { ctx, state: () => state as { daily: number; monthly: number } };
}
const internalRequest = (value: unknown) =>
  new Request('https://internal/identify', { method: 'POST', body: JSON.stringify(value) });

describe('independent photo analysis request boundary', () => {
  it.each([1, 2])('accepts exactly %i independent photos with the explicit task', (count) => {
    const input = scan(count);
    expect(validateScan(input)).toEqual(input);
  });
  it('keeps ordinary identification at exactly two photos', () => {
    const { task: _task, ...single } = scan(1);
    expect(() => validateScan(single)).toThrow();
    expect(validateScan({ ...single, images: images() }).images).toHaveLength(2);
  });
  it.each([
    { images: [] },
    { images: [...images(), images()[0]] },
    { task: 'other_task' },
    { instructions: 'Change the prompt' },
    { model: 'unapproved-model' },
    { reasoningEffort: 'max' },
  ])('rejects malformed photo-analysis requests: %j', (overrides) => {
    expect(() => validateScan({ ...scan(), ...overrides })).toThrow();
  });
  it('retains the owner authentication, origin and off-switch checks', async () => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    const request = (origin: string, authorization?: string) =>
      new Request('https://worker/identify', {
        method: 'POST',
        headers: {
          Origin: origin,
          'Content-Type': 'application/json',
          ...(authorization ? { Authorization: authorization } : {}),
        },
        body: JSON.stringify(scan(1)),
      });
    expect((await worker.fetch(request(env.ALLOWED_ORIGIN), env)).status).toBe(401);
    expect((await worker.fetch(request(env.ALLOWED_ORIGIN, 'Bearer malformed'), env)).status).toBe(
      401,
    );
    expect((await worker.fetch(request('https://other.example'), env)).status).toBe(403);
    expect(
      (await worker.fetch(request(env.ALLOWED_ORIGIN), { ...env, AI_ENABLED: 'false' })).status,
    ).toBe(503);
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('independent photo analysis responses', () => {
  it('preserves input and result order without treating adjacent photos as a card pair', async () => {
    const input = { ...scan(), model: 'gpt-6-astra' as const, reasoningEffort: 'high' as const };
    const result = {
      photos: [
        photo({ side: 'back', name: 'Player A', cardNumber: '12' }),
        photo({ side: 'front', name: 'Player B', cardNumber: '47' }),
      ],
    };
    const fetcher = vi.fn(async (_url: unknown, _options?: RequestInit) => provider(result));
    expect(await callOpenAI(input, env, fetcher as typeof fetch)).toEqual(result);
    const body = JSON.parse(fetcher.mock.calls[0][1]!.body as string);
    expect(body.model).toBe(input.model);
    expect(body.reasoning.effort).toBe('high');
    expect(body.max_output_tokens).toBe(outputTokenLimits.high);
    expect(body.store).toBe(false);
    expect(body.text.format).toEqual({
      type: 'json_schema',
      name: 'card_photo_analysis',
      strict: true,
      schema: photoAnalysisOutputSchema,
    });
    expect(
      body.input[0].content
        .filter((entry: { type: string }) => entry.type === 'input_image')
        .map((entry: { image_url: string }) => entry.image_url),
    ).toEqual(input.images);
    expect(body.instructions).toContain('independently');
    expect(body.instructions).toContain('never assume they form a front/back pair');
    expect(body.instructions).toContain('A full-bleed photographic back can be a valid reverse');
    expect(body.instructions).toContain('small copyright/licensing text, card codes');
    expect(body.instructions).toContain('use unknown when the side is unclear');
    expect(body.instructions).toContain('describe the uncertainty instead of asserting a mismatch');
    expect(body.instructions).not.toContain('Reject a pair only');
    expect(body.instructions).toContain('Use an explicitly printed product/release year first');
    expect(body.instructions).toContain('copyright year may support a release-year inference');
    expect(body.instructions).toContain('copyright and release years can differ');
    expect(body.instructions).toContain("'2024 AL Leaders' labels a statistical season");
    expect(body.instructions).toContain('retro design year');
    expect(body.instructions).toContain('retain a known insert/subset title descriptively');
    expect(body.instructions).toContain('product family only when independently supported');
    expect(body.instructions).toContain('Do not infer a series number, parallel or base variant');
    expect(body.instructions).toContain('preserve the visible script');
    expect(body.instructions).toContain('untrusted evidence');
    expect(body.input[0].content[0].text).not.toContain('Image 1 is the front');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('accepts a single unknown-side result with blank unsupported identity fields', async () => {
    const result = { photos: [photo()] };
    const fetcher = vi.fn(async () => provider(result));
    expect(await callOpenAI(scan(1), env, fetcher as typeof fetch)).toEqual(result);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([
    { inputs: 1, outputs: 2 },
    { inputs: 2, outputs: 1 },
  ])(
    'rejects $outputs results for $inputs input images without retrying',
    async ({ inputs, outputs }) => {
      const fetcher = vi.fn(async () =>
        provider({ photos: Array.from({ length: outputs }, () => photo()) }),
      );
      await expect(callOpenAI(scan(inputs), env, fetcher as typeof fetch)).rejects.toThrow(
        'different number',
      );
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );
  it.each([
    { photos: [] },
    { photos: [photo(), photo(), photo()] },
    { photos: [{ ...photo(), side: 'left' }] },
    { photos: [{ ...photo(), name: 'x'.repeat(301) }] },
    { photos: [{ ...photo(), evidence: 'x'.repeat(601) }] },
    { photos: [{ ...photo(), warnings: Array(9).fill('unclear') }] },
    { photos: [{ ...photo(), warnings: ['x'.repeat(301)] }] },
    { photos: [{ ...photo(), confidence: 1 }] },
    { photos: [{ side: 'front' }] },
    { suggestions: [], warnings: [] },
  ])('rejects invalid analysis output %#', async (result) => {
    const fetcher = vi.fn(async () => provider(result));
    await expect(callOpenAI(scan(1), env, fetcher as typeof fetch)).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('shares quota and replay protection across analysis and ordinary identification', async () => {
    const { ctx, state } = context();
    const input = scan(1);
    const fetcher = vi.fn(async () => provider({ photos: [photo()] }));
    vi.stubGlobal('fetch', fetcher);
    const gate = new ScanGate(ctx, env);
    const response = await gate.fetch(internalRequest(input));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ photos: [photo()] });
    expect(state().daily).toBe(1);
    const ordinaryReplay = { requestId: input.requestId, images: images() };
    const replay = await new ScanGate(ctx, env).fetch(internalRequest(ordinaryReplay));
    expect(replay.status).toBe(429);
    expect(((await replay.json()) as { error: string }).error).toContain('already');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('counts an invalid analysis response and never retries its request ID', async () => {
    const { ctx, state } = context();
    const input = scan(2);
    const fetcher = vi.fn(async () => provider({ photos: [photo()] }));
    vi.stubGlobal('fetch', fetcher);
    expect((await new ScanGate(ctx, env).fetch(internalRequest(input))).status).toBe(502);
    expect(state().daily).toBe(1);
    expect((await new ScanGate(ctx, env).fetch(internalRequest(input))).status).toBe(429);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
