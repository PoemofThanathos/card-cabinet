import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Dexie from 'dexie';
import {
  CabinetDB,
  changeStatus,
  purgeDeletedCards,
  saveCard,
  setSetting,
  setting,
} from '../src/db';
import { type ProcessingSpeed } from '../src/processing-speed';
import {
  createPhotoMatchingJob,
  deletePhotoMatchingJob,
  photoMatchingKey,
} from '../src/photo-matching';
import { fileKey } from '../src/bulk-entry';
import { newCard, plainCard, type Suggestions, type Card } from '../src/model';
import {
  aiLeaseMs,
  defaultIdentificationOptions,
  type IdentificationOptions,
} from '../src/ai-options';
import {
  applyBatchReview,
  batchKey,
  checkBatchAllowance,
  createBatch,
  reviewPrefix,
  runBatch,
  withBatchLock,
  type IdentificationBatch,
  type BatchReview,
} from '../src/batch';

let database: CabinetDB;
let clock: number;
const suggestions: Suggestions = {
  suggestions: [
    {
      field: 'name',
      value: 'Read player',
      source: 'visible_text',
      evidence: 'Printed name',
      uncertain: false,
    },
  ],
  warnings: [],
};
const lock = async <T>(action: () => Promise<T>) => action();
const ready = async () => {};
const options = () => ({
  database,
  lock,
  ready,
  now: () => clock,
  wait: async (milliseconds: number) => {
    clock += milliseconds;
  },
});
beforeEach(async () => {
  database = new CabinetDB('batch-test-' + crypto.randomUUID());
  await database.open();
  clock = Date.now();
  await setSetting('aiUnlimited', true, database);
  await database.photos.put({
    hash: 'a'.repeat(64),
    bytes: new ArrayBuffer(4),
    size: 4,
    type: 'image/jpeg',
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await database.delete();
});
async function cards(count: number) {
  const result: Card[] = [];
  for (let i = 0; i < count; i++) {
    const card = newCard();
    card.fields.cardNumber = String(i + 1);
    card.photos = { front: 'a'.repeat(64), back: 'a'.repeat(64) };
    await saveCard(card, [], database);
    result.push(plainCard((await database.cards.get(card.id))!));
  }
  return result;
}
const reviewKeys = () => database.settings.where('key').startsWith(reviewPrefix).primaryKeys();
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe('parallel batch speeds', () => {
  it('waits out a discarded matching request before switching to Ultra fast identification', async () => {
    const [card] = await cards(1);
    const sources = [
      { name: 'front.jpg', size: 4, lastModified: 1 },
      { name: 'back.jpg', size: 4, lastModified: 1 },
    ];
    const matching = await createPhotoMatchingJob(sources, defaultIdentificationOptions, {
      ...options(),
      speed: 'fast',
    });
    await setSetting(photoMatchingKey, { ...matching, processing: sources.map(fileKey) }, database);
    const interruptedAt = clock;
    await deletePhotoMatchingJob(matching.id, options());
    const job = await createBatch([card.id], { ...options(), speed: 'ultra' });
    await runBatch(job.id, {
      ...options(),
      identifyCard: async () => {
        expect(clock - interruptedAt).toBeGreaterThanOrEqual(aiLeaseMs);
        return suggestions;
      },
    });
  });
  it.each([
    ['fast', 2],
    ['ultra', 4],
  ] as const)(
    'limits %s to %i requests and saves out-of-order results by card',
    async (speed, concurrency) => {
      const selected = await cards(7);
      const job = await createBatch(
        selected.map((card) => card.id),
        { ...options(), speed },
      );
      const pending: { card: Card; response: ReturnType<typeof deferred<Suggestions>> }[] = [];
      let active = 0,
        peak = 0;
      const identifyCard = vi.fn(
        async (card: Card, _choice?: IdentificationOptions, actualSpeed?: ProcessingSpeed) => {
          expect(actualSpeed).toBe(speed);
          const response = deferred<Suggestions>();
          pending.push({ card, response });
          peak = Math.max(peak, ++active);
          try {
            return await response.promise;
          } finally {
            active--;
          }
        },
      );
      const wait = vi.fn(options().wait);
      const finished = runBatch(job.id, { ...options(), wait, identifyCard });
      for (let start = 0; start < selected.length; start += concurrency) {
        const end = Math.min(start + concurrency, selected.length);
        await vi.waitFor(() => expect(pending).toHaveLength(end));
        const checkpoint = await setting<IdentificationBatch | null>(batchKey, null, database);
        expect(checkpoint?.nextPosition).toBe(end);
        expect(checkpoint?.inFlight).toHaveLength(end - start);
        for (let index = end - 1; index >= start; index--) {
          const result = structuredClone(suggestions);
          result.suggestions[0].value = 'Player ' + pending[index].card.fields.cardNumber;
          pending[index].response.resolve(result);
          await vi.waitFor(async () =>
            expect(
              await database.settings.get(reviewPrefix + job.id + ':' + pending[index].card.id),
            ).toBeDefined(),
          );
        }
      }
      const result = await finished;
      expect(peak).toBe(concurrency);
      expect(wait).not.toHaveBeenCalled();
      expect(result.position).toBe(7);
      expect(result.nextPosition).toBe(7);
      expect(result.inFlight).toEqual([]);
      expect(result.status).toBe('complete');
      for (const card of selected) {
        const review = await setting<BatchReview | null>(
          reviewPrefix + job.id + ':' + card.id,
          null,
          database,
        );
        expect(review?.result.suggestions[0].value).toBe('Player ' + card.fields.cardNumber);
      }
    },
  );

  it('stops launches after a failed parallel request and saves its still-running peer', async () => {
    const selected = await cards(5);
    const job = await createBatch(
      selected.map((card) => card.id),
      { ...options(), speed: 'fast' },
    );
    const responses = [deferred<Suggestions>(), deferred<Suggestions>()];
    let called = 0;
    const running = runBatch(job.id, {
      ...options(),
      identifyCard: async () => responses[called++].promise,
    });
    await vi.waitFor(() => expect(called).toBe(2));
    responses[1].reject(new Error('API unavailable'));
    await vi.waitFor(async () =>
      expect(
        (await setting<IdentificationBatch | null>(batchKey, null, database))?.failures,
      ).toHaveLength(1),
    );
    expect(called).toBe(2);
    responses[0].resolve(suggestions);
    const paused = await running;
    expect(paused.status).toBe('paused');
    expect(paused.position).toBe(2);
    expect(await reviewKeys()).toHaveLength(1);
    const next = vi.fn(async (_card: Card) => suggestions);
    const complete = await runBatch(job.id, { ...options(), identifyCard: next });
    expect(next.mock.calls.map(([card]) => card.id)).toEqual(
      selected.slice(2).map((card) => card.id),
    );
    expect(complete.position).toBe(5);
    expect(await reviewKeys()).toHaveLength(4);
  });

  it('pauses after all four active requests finish and resumes at a different speed', async () => {
    const selected = await cards(6);
    const job = await createBatch(
      selected.map((card) => card.id),
      { ...options(), speed: 'ultra' },
    );
    const control = new AbortController();
    const responses = Array.from({ length: 4 }, () => deferred<Suggestions>());
    let called = 0;
    const running = runBatch(job.id, {
      ...options(),
      signal: control.signal,
      identifyCard: async () => responses[called++].promise,
    });
    await vi.waitFor(() => expect(called).toBe(4));
    control.abort();
    for (const response of responses.toReversed()) response.resolve(suggestions);
    const paused = await running;
    expect(paused.status).toBe('paused');
    expect(paused.position).toBe(4);
    expect(paused.inFlight).toEqual([]);
    const started: number[] = [];
    const next = vi.fn(
      async (_card: Card, _choice?: IdentificationOptions, speed?: ProcessingSpeed) => {
        expect(speed).toBe('normal');
        started.push(clock);
        return suggestions;
      },
    );
    const finished = await runBatch(job.id, { ...options(), speed: 'normal', identifyCard: next });
    expect(next).toHaveBeenCalledTimes(2);
    expect(started[1] - started[0]).toBeGreaterThanOrEqual(15000);
    expect(finished.speed).toBe('normal');
    expect(await reviewKeys()).toHaveLength(6);
  });

  it('recovers every unfinished parallel request without replaying completed or unknown requests', async () => {
    const selected = await cards(6);
    const job = await createBatch(
      selected.map((card) => card.id),
      { ...options(), speed: 'ultra' },
    );
    await setSetting(
      reviewPrefix + job.id + ':' + selected[2].id,
      { batchId: job.id, card: selected[2], result: suggestions },
      database,
    );
    await setSetting(
      batchKey,
      {
        ...job,
        position: 1,
        nextPosition: 4,
        status: 'running',
        processing: selected[0].id,
        inFlight: [0, 1, 3].map((index) => ({
          cardId: selected[index].id,
          index,
          startedAt: clock,
        })),
      },
      database,
    );
    const recoveredAt = clock;
    const next = vi.fn(async (_card: Card) => {
      expect(clock - recoveredAt).toBeGreaterThanOrEqual(aiLeaseMs);
      return suggestions;
    });
    const result = await runBatch(job.id, { ...options(), speed: 'fast', identifyCard: next });
    expect(next.mock.calls.map(([card]) => card.id)).toEqual(
      selected.slice(4).map((card) => card.id),
    );
    expect(result.position).toBe(6);
    expect(result.failures.map((failure) => failure.cardId)).toEqual(
      [0, 1, 3].map((index) => selected[index].id),
    );
    expect(result.failures.every((failure) => failure.error.includes('not retried'))).toBe(true);
    expect(await reviewKeys()).toHaveLength(3);
  });

  it('retains completed peers when one parallel result cannot be stored', async () => {
    const selected = await cards(3);
    const job = await createBatch(
      selected.map((card) => card.id),
      { ...options(), speed: 'fast' },
    );
    const original = database.settings.put.bind(database.settings);
    const put = vi
      .spyOn(database.settings, 'put')
      .mockImplementation((row) =>
        row.key === reviewPrefix + job.id + ':' + selected[0].id
          ? Dexie.Promise.reject(new Error('Storage full'))
          : original(row),
      );
    const responses = [deferred<Suggestions>(), deferred<Suggestions>()];
    let called = 0;
    const running = runBatch(job.id, {
      ...options(),
      identifyCard: async () => responses[called++].promise,
    });
    const failed = expect(running).rejects.toThrow('Storage full');
    await vi.waitFor(() => expect(called).toBe(2));
    responses[1].resolve(suggestions);
    await vi.waitFor(async () => expect(await reviewKeys()).toHaveLength(1));
    responses[0].resolve(suggestions);
    await failed;
    const saved = await setting<IdentificationBatch | null>(batchKey, null, database);
    expect(saved?.inFlight?.map((request) => request.cardId)).toEqual([selected[0].id]);
    expect(saved?.position).toBe(1);
    put.mockRestore();
    const next = vi.fn(async (_card: Card) => suggestions);
    await runBatch(job.id, { ...options(), identifyCard: next });
    expect(next.mock.calls.map(([card]) => card.id)).toEqual([selected[2].id]);
    expect(await reviewKeys()).toHaveLength(2);
  });

  it('does not restore a purged card or its suggestions when parallel requests finish', async () => {
    const selected = await cards(3);
    const job = await createBatch(
      selected.map((card) => card.id),
      { ...options(), speed: 'fast' },
    );
    const control = new AbortController();
    const responses = [deferred<Suggestions>(), deferred<Suggestions>()];
    let called = 0;
    const running = runBatch(job.id, {
      ...options(),
      signal: control.signal,
      identifyCard: async () => responses[called++].promise,
    });
    await vi.waitFor(() => expect(called).toBe(2));
    control.abort();
    await changeStatus(selected[0], 'deleted', database);
    await purgeDeletedCards([selected[0].id], database);
    responses[1].resolve(suggestions);
    responses[0].resolve(suggestions);
    const paused = await running;
    expect(paused.position).toBe(2);
    expect((await database.cards.get(selected[0].id))?.status).toBe('purged');
    expect(
      await database.settings.get(reviewPrefix + job.id + ':' + selected[0].id),
    ).toBeUndefined();
    expect(await reviewKeys()).toHaveLength(1);
    expect(paused.failures[0].name).toBe('Permanently deleted card');
  });
});

describe('saved identification batches', () => {
  it('refreshes the photo-matching cooldown before resuming an older identification queue', async () => {
    const [card] = await cards(1);
    const job = await createBatch([card.id], options());
    clock += 500;
    await setSetting('aiPhotoMatchingLastAttemptAt', clock, database);
    const matchedAt = clock;
    const identifyCard = vi.fn(async () => {
      expect(clock - matchedAt).toBeGreaterThanOrEqual(15000);
      return suggestions;
    });
    const result = await runBatch(job.id, { ...options(), identifyCard });
    expect(identifyCard).toHaveBeenCalledTimes(1);
    expect(result.failures).toEqual([]);
    expect(result.status).toBe('complete');
  });

  it.each(['new', 'resumed'] as const)(
    'waits out an unknown photo-analysis request before a %s identification queue',
    async (mode) => {
      const [card] = await cards(1);
      const saved = mode === 'resumed' ? await createBatch([card.id], options()) : null;
      const matching = {
        processing: ['front.jpg', 'back.jpg'],
        lastAttemptAt: clock,
        notBefore: 0,
      };
      await setSetting('aiPhotoMatching', matching, database);
      await setSetting('aiPhotoMatchingLastAttemptAt', clock, database);
      const job = saved ?? (await createBatch([card.id], options()));
      const resumedAt = clock;
      const identifyCard = vi.fn(async () => {
        expect(clock - resumedAt).toBeGreaterThanOrEqual(aiLeaseMs);
        return suggestions;
      });
      const result = await runBatch(job.id, { ...options(), identifyCard });
      expect(identifyCard).toHaveBeenCalledTimes(1);
      expect(result.failures).toEqual([]);
      expect(await setting('aiPhotoMatching', null, database)).toEqual(matching);
    },
  );

  it('keeps the approved model and reasoning through setting changes, pause and resume', async () => {
    const selected = await cards(2);
    const approved: IdentificationOptions = { model: 'gpt-6.1-terra', reasoningEffort: 'high' };
    await setSetting('aiOptions', approved, database);
    const job = await createBatch(
      selected.map((card) => card.id),
      options(),
    );
    expect(job.identificationOptions).toEqual(approved);
    await setSetting('aiOptions', { model: 'gpt-6-astra', reasoningEffort: 'medium' }, database);
    const control = new AbortController();
    const first = vi.fn(async (_card: Card, choice?: IdentificationOptions) => {
      expect(choice).toEqual(approved);
      control.abort();
      return suggestions;
    });
    await runBatch(job.id, { ...options(), signal: control.signal, identifyCard: first });
    await setSetting('aiOptions', { model: 'gpt-6.1-sol', reasoningEffort: 'low' }, database);
    const next = vi.fn(async (_card: Card, choice?: IdentificationOptions) => {
      expect(choice).toEqual(approved);
      return suggestions;
    });
    const finished = await runBatch(job.id, { ...options(), identifyCard: next });
    expect(first).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledTimes(1);
    expect(finished.identificationOptions).toEqual(approved);
    for (const key of await reviewKeys())
      expect(
        (await setting<BatchReview | null>(key, null, database))?.identificationOptions,
      ).toEqual(approved);
  });

  it('uses the confirmation snapshot even if preferences changed before queue creation', async () => {
    const [card] = await cards(1);
    await setSetting('aiOptions', { model: 'gpt-6-astra', reasoningEffort: 'high' }, database);
    const approved: IdentificationOptions = { model: 'gpt-6.1-sol', reasoningEffort: 'medium' };
    const job = await createBatch([card.id], { ...options(), identificationOptions: approved });
    expect(job.identificationOptions).toEqual(approved);
    const identifyCard = vi.fn(async (_card: Card, choice?: IdentificationOptions) => {
      expect(choice).toEqual(approved);
      return suggestions;
    });
    await runBatch(job.id, { ...options(), identifyCard });
  });

  it('resumes a legacy queue with Luna Low rather than current preferences', async () => {
    const [card] = await cards(1);
    const job = await createBatch([card.id], options());
    delete job.identificationOptions;
    delete job.speed;
    delete job.nextPosition;
    delete job.inFlight;
    delete job.notBefore;
    await setSetting(batchKey, job, database);
    await setSetting('aiOptions', { model: 'gpt-6-astra', reasoningEffort: 'high' }, database);
    const identifyCard = vi.fn(
      async (_card: Card, choice?: IdentificationOptions, speed?: ProcessingSpeed) => {
        expect(choice).toEqual(defaultIdentificationOptions);
        expect(speed).toBe('normal');
        return suggestions;
      },
    );
    const finished = await runBatch(job.id, { ...options(), identifyCard });
    expect(finished.identificationOptions).toEqual(defaultIdentificationOptions);
    const [key] = await reviewKeys();
    expect((await setting<BatchReview | null>(key, null, database))?.identificationOptions).toEqual(
      defaultIdentificationOptions,
    );
  });

  it('runs more than 100 cards sequentially with spacing and saves unapplied results', async () => {
    const selected = await cards(101);
    const job = await createBatch(
      selected.map((c) => c.id),
      options(),
    );
    const started: number[] = [];
    const completed: number[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const identifyCard = vi.fn(async () => {
      maxInFlight = Math.max(maxInFlight, ++inFlight);
      started.push(clock);
      clock += started.length % 2 ? 17000 : 500;
      await Promise.resolve();
      completed.push(clock);
      inFlight--;
      return suggestions;
    });
    const result = await runBatch(job.id, { ...options(), identifyCard });
    expect(result.status).toBe('complete');
    expect(result.position).toBe(101);
    expect(identifyCard).toHaveBeenCalledTimes(101);
    expect(maxInFlight).toBe(1);
    expect(started.slice(1).every((time, i) => time - started[i] >= 15000)).toBe(true);
    expect(started.slice(1).every((time, i) => time - completed[i] >= 15000)).toBe(true);
    expect(await reviewKeys()).toHaveLength(101);
    expect((await database.cards.toArray()).every((c) => c.fields.name === '')).toBe(true);
  });

  it('enforces remaining device allowance unless unlimited is enabled', async () => {
    await setSetting('aiUnlimited', false, database);
    await setSetting('aiLimit', 3, database);
    await setSetting('aiUsage', { day: new Date().toISOString().slice(0, 10), count: 2 }, database);
    await expect(checkBatchAllowance(2, database)).rejects.toThrow('1 left');
    await expect(checkBatchAllowance(1, database)).resolves.toBeUndefined();
    await setSetting('aiUnlimited', true, database);
    await expect(checkBatchAllowance(100000, database)).resolves.toBeUndefined();
    await setSetting('aiUnlimited', false, database);
    await expect(checkBatchAllowance(2, database)).rejects.toThrow('1 left');
    await setSetting('aiUsage', { day: '2000-01-01', count: 100 }, database);
    await expect(checkBatchAllowance(3, database)).resolves.toBeUndefined();
  });

  it('pauses after the current card, then resumes without repeating it', async () => {
    const selected = await cards(3);
    const job = await createBatch(
      selected.map((c) => c.id),
      options(),
    );
    const control = new AbortController();
    const identifyCard = vi.fn(async () => {
      control.abort();
      return suggestions;
    });
    const paused = await runBatch(job.id, { ...options(), signal: control.signal, identifyCard });
    expect(paused.status).toBe('paused');
    expect(paused.position).toBe(1);
    expect(await reviewKeys()).toHaveLength(1);
    const next = vi.fn(async () => suggestions);
    const finished = await runBatch(job.id, { ...options(), identifyCard: next });
    expect(finished.status).toBe('complete');
    expect(next.mock.calls).toHaveLength(2);
    expect(await reviewKeys()).toHaveLength(3);
  });

  it('stops on failure, keeps earlier suggestions, and continues only the remaining cards', async () => {
    const selected = await cards(3);
    const job = await createBatch(
      selected.map((c) => c.id),
      options(),
    );
    const identifyCard = vi.fn(async (card: Card) => {
      if (card.id === selected[1].id) throw new Error('Response lost');
      return suggestions;
    });
    const failed = await runBatch(job.id, { ...options(), identifyCard });
    expect(failed.position).toBe(2);
    expect(failed.status).toBe('paused');
    expect(failed.failures[0].cardId).toBe(selected[1].id);
    expect(await reviewKeys()).toHaveLength(1);
    const next = vi.fn(async (_card: Card) => suggestions);
    await runBatch(job.id, { ...options(), identifyCard: next });
    expect(next).toHaveBeenCalledTimes(1);
    expect(next.mock.calls[0][0].id).toBe(selected[2].id);
    expect(await reviewKeys()).toHaveLength(2);
  });

  it('skips an interrupted request and waits for its server lease instead of retrying it', async () => {
    const selected = await cards(2);
    const job = await createBatch(
      selected.map((c) => c.id),
      options(),
    );
    job.processing = selected[0].id;
    job.status = 'running';
    job.lastStart = clock;
    await setSetting(batchKey, job, database);
    const originalTime = clock;
    const identifyCard = vi.fn(async (_card: Card) => suggestions);
    const result = await runBatch(job.id, { ...options(), identifyCard });
    expect(result.failures[0].error).toContain('not retried');
    expect(identifyCard).toHaveBeenCalledTimes(1);
    expect(identifyCard.mock.calls[0][0].id).toBe(selected[1].id);
    expect(clock - originalTime).toBeGreaterThanOrEqual(aiLeaseMs);
  });

  it('preserves the in-flight marker when local result storage fails', async () => {
    const selected = await cards(2);
    const job = await createBatch(
      selected.map((c) => c.id),
      options(),
    );
    const originalPut = database.settings.put.bind(database.settings);
    const put = vi.spyOn(database.settings, 'put').mockImplementation((row) => {
      if (row.key?.startsWith(reviewPrefix)) return Dexie.Promise.reject(new Error('Storage full'));
      return originalPut(row);
    });
    const identifyCard = vi.fn(async () => suggestions);
    await expect(runBatch(job.id, { ...options(), identifyCard })).rejects.toThrow('Storage full');
    expect(identifyCard).toHaveBeenCalledTimes(1);
    const saved = await setting<IdentificationBatch | null>(batchKey, null, database);
    expect(saved?.processing).toBe(selected[0].id);
    expect(saved?.position).toBe(0);
    expect(await reviewKeys()).toHaveLength(0);
    put.mockRestore();
    const next = vi.fn(async (_card: Card) => suggestions);
    await runBatch(job.id, { ...options(), identifyCard: next });
    expect(next).toHaveBeenCalledTimes(1);
    expect(next.mock.calls[0][0].id).toBe(selected[1].id);
  });

  it('checks all local image pairs before replacing a saved queue', async () => {
    const selected = await cards(2);
    const existing = await createBatch([selected[0].id], options());
    const incomplete = { ...selected[1], photos: { front: selected[1].photos.front, back: null } };
    await saveCard(incomplete, [], database);
    await expect(createBatch([selected[1].id], options())).rejects.toThrow('back photo');
    expect((await setting<IdentificationBatch | null>(batchKey, null, database))?.id).toBe(
      existing.id,
    );
  });

  it('refuses a second tab while the Web Lock is held', async () => {
    vi.stubGlobal('navigator', {
      locks: {
        request: async (_name: string, _options: unknown, fn: (lock: null) => Promise<unknown>) =>
          fn(null),
      },
    });
    const action = vi.fn(async () => 'called');
    await expect(withBatchLock(action)).rejects.toThrow('Another tab');
    expect(action).not.toHaveBeenCalled();
  });
});

describe('reviewed batch results', () => {
  it('applies only selected supported suggestions and queues the card for sync', async () => {
    const [card] = await cards(1);
    const job = await createBatch([card.id], options());
    await runBatch(job.id, { ...options(), identifyCard: async () => suggestions });
    const [key] = await reviewKeys();
    await applyBatchReview(key, { name: 'Read player', notes: 'Not a suggestion' }, database);
    const saved = await database.cards.get(card.id);
    expect(saved?.fields.name).toBe('Read player');
    expect(saved?.fields.notes).toBe('');
    expect(saved?.localVersion).toBe(2);
    expect(await database.queue.get(card.id)).toBeDefined();
    expect(await reviewKeys()).toHaveLength(0);
  });

  it('keeps both the edited card and suggestions when a stale review is applied', async () => {
    const [card] = await cards(1);
    const job = await createBatch([card.id], options());
    await runBatch(job.id, { ...options(), identifyCard: async () => suggestions });
    const [key] = await reviewKeys();
    await saveCard(
      { ...card, fields: { ...card.fields, name: 'Manual correction' } },
      [],
      database,
    );
    await expect(applyBatchReview(key, { name: 'Read player' }, database)).rejects.toThrow(
      'changed after',
    );
    expect((await database.cards.get(card.id))?.fields.name).toBe('Manual correction');
    expect(await database.settings.get(key)).toBeDefined();
  });
});
