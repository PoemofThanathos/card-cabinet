import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Dexie from 'dexie';
import { CabinetDB, saveCard, setSetting, setting } from '../src/db';
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
    await setSetting(batchKey, job, database);
    await setSetting('aiOptions', { model: 'gpt-6-astra', reasoningEffort: 'high' }, database);
    const identifyCard = vi.fn(async (_card: Card, choice?: IdentificationOptions) => {
      expect(choice).toEqual(defaultIdentificationOptions);
      return suggestions;
    });
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
