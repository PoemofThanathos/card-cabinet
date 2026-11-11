import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Dexie from 'dexie';
import { CabinetDB, makePhoto, saveCard } from '../src/db';
import {
  bulkCard,
  BulkSaveError,
  fileKey,
  fileReference,
  getBulkEntryPlan,
  localImportCapabilities,
  saveBulkEntries,
  storeBulkEntryPlan,
  type BulkEntryPlan,
} from '../src/bulk-entry';
import { type ProcessingSpeed } from '../src/processing-speed';

let database: CabinetDB;
beforeEach(() => {
  database = new CabinetDB('local-speed-' + crypto.randomUUID());
  vi.stubGlobal('navigator', { hardwareConcurrency: 8 });
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await database.delete();
});
const metadataPlan = (count: number, kind: BulkEntryPlan['kind'] = 'manual'): BulkEntryPlan => ({
  id: crypto.randomUUID(),
  kind,
  entries: Array.from({ length: count }, (_, i) => ({
    card: bulkCard(
      { maker: 'Topps', set: 'Speed test', year: '2026' },
      { cardNumber: String(i + 1) },
      kind === 'base',
    ),
    state: 'pending',
  })),
});
function photoPlan(count: number) {
  const plan = metadataPlan(count, 'photos');
  const files = new Map<string, File>();
  for (const [index, entry] of plan.entries.entries()) {
    const pair = ['front', 'back'].map(
      (side) => new File([`${index}-${side}`], `${index}-${side}.jpg`, { lastModified: 1 }),
    );
    pair.forEach((file) => files.set(fileKey(file), file));
    entry.sources = [fileReference(pair[0]), fileReference(pair[1])];
  }
  return { plan, files };
}

it.each([
  ['normal', 1],
  ['fast', 2],
  ['ultra', 4],
] as const)(
  '%s uses bounded photo work and preserves progress from out-of-order commits',
  async (speed, expected) => {
    const { plan, files } = photoPlan(12);
    await storeBulkEntryPlan(plan, database);
    let active = 0,
      maximum = 0;
    const progress: number[] = [];
    const finished = await saveBulkEntries(plan, files, {
      speed,
      database,
      encode: async (file) => {
        maximum = Math.max(maximum, ++active);
        await new Promise((resolve) =>
          setTimeout(resolve, (file as File).name.startsWith('0-') ? 8 : 2),
        );
        const encoded = await makePhoto(file);
        active--;
        return encoded;
      },
      onProgress: (next) =>
        progress.push(next.entries.filter((entry) => entry.state === 'saved').length),
    });
    expect(maximum).toBe(expected);
    expect(finished.entries.every((entry) => entry.state === 'saved')).toBe(true);
    expect(progress).toEqual(Array.from({ length: 12 }, (_, index) => index + 1));
    expect(await database.cards.count()).toBe(12);
    expect(await database.queue.count()).toBe(12);
  },
);

it('pauses after in-flight cards and resumes without duplicating physical cards', async () => {
  const { plan, files } = photoPlan(12);
  await storeBulkEntryPlan(plan, database);
  const abort = new AbortController();
  const paused = await saveBulkEntries(plan, files, {
    speed: 'ultra',
    database,
    signal: abort.signal,
    encode: makePhoto,
    onProgress: () => abort.abort(),
  });
  expect(paused.entries.filter((entry) => entry.state === 'saved')).toHaveLength(4);
  const finished = await saveBulkEntries(paused, files, {
    speed: 'ultra',
    database,
    encode: makePhoto,
  });
  expect(finished.entries.every((entry) => entry.state === 'saved')).toBe(true);
  expect(await database.cards.count()).toBe(12);
});

it('returns all committed progress with a failure, then resumes only pending entries', async () => {
  const { plan, files } = photoPlan(9);
  await storeBulkEntryPlan(plan, database);
  let failure: BulkSaveError | undefined;
  try {
    await saveBulkEntries(plan, files, {
      speed: 'ultra',
      database,
      encode: async (file) => {
        if ((file as File).name === '2-front.jpg') throw new Error('Damaged photo');
        return makePhoto(file);
      },
    });
  } catch (error) {
    failure = error as BulkSaveError;
  }
  expect(failure).toBeInstanceOf(BulkSaveError);
  expect(failure?.index).toBe(2);
  expect(failure?.plan.entries[2].state).toBe('pending');
  expect(failure?.plan.entries.filter((entry) => entry.state === 'saved')).toHaveLength(3);
  const finished = await saveBulkEntries(failure!.plan, files, {
    speed: 'ultra',
    database,
    encode: makePhoto,
  });
  expect(finished.entries.every((entry) => entry.state === 'saved')).toBe(true);
  expect(await database.cards.count()).toBe(9);
});

it('keeps photo writes atomic under storage failure and concurrent resume', async () => {
  const { plan, files } = photoPlan(8);
  await storeBulkEntryPlan(plan, database);
  const queue = vi
    .spyOn(database.queue, 'bulkPut')
    .mockImplementationOnce(() => Dexie.Promise.reject(new Error('Storage full')));
  await expect(
    saveBulkEntries(plan, files, { speed: 'normal', database, encode: makePhoto }),
  ).rejects.toThrow('Storage full');
  expect(await database.cards.count()).toBe(0);
  expect(await database.photos.count()).toBe(0);
  expect((await getBulkEntryPlan(database))?.entries[0].state).toBe('pending');
  queue.mockRestore();
  await Promise.all(
    [1, 2].map(() => saveBulkEntries(plan, files, { speed: 'ultra', database, encode: makePhoto })),
  );
  expect(await database.cards.count()).toBe(8);
  expect(await database.queue.count()).toBe(8);
});

it('groups base-set writes, deduplicates within each group and rechecks ownership between groups', async () => {
  const plan = metadataPlan(65, 'base');
  plan.entries[1].card.fields.cardNumber = '1';
  await storeBulkEntryPlan(plan, database);
  const scans = vi.spyOn(database.cards, 'each');
  let added = false;
  const finished = await saveBulkEntries(plan, new Map(), {
    speed: 'ultra',
    database,
    onProgress: () => {
      if (!added) {
        added = true;
        // Simulates another writer queued between the two bounded transactions.
        void saveCard(
          bulkCard({ maker: 'Topps', set: 'Speed test', year: '2026' }, { cardNumber: '65' }, true),
          [],
          database,
        );
      }
    },
  });
  expect(scans).toHaveBeenCalledTimes(2);
  expect(finished.entries[1].state).toBe('existing');
  expect(finished.entries[64].state).toBe('existing');
  expect(await database.cards.count()).toBe(64);
});

it('reports a lower Ultra photo ceiling on small devices', () => {
  vi.stubGlobal('navigator', { hardwareConcurrency: 2 });
  expect(localImportCapabilities('ultra')).toMatchObject({
    requestedConcurrency: 4,
    photoConcurrency: 2,
    heicConcurrency: 1,
  });
  expect(localImportCapabilities('ultra').note).toContain('up to 2');
});

it('benchmarks synthetic base-set imports with equal contents and no simulated delays', async () => {
  const results: Partial<Record<ProcessingSpeed, number>> = {};
  for (const speed of ['normal', 'fast', 'ultra'] as const) {
    const trial = new CabinetDB('import-benchmark-' + crypto.randomUUID());
    try {
      const plan = metadataPlan(350, 'base');
      await storeBulkEntryPlan(plan, trial);
      const start = performance.now();
      await saveBulkEntries(plan, new Map(), { speed, database: trial });
      results[speed] = Math.round(performance.now() - start);
      expect(await trial.cards.count()).toBe(350);
      expect(await trial.queue.count()).toBe(350);
    } finally {
      await trial.delete();
    }
  }
  console.info('Synthetic 350-card base import, fake IndexedDB, milliseconds:', results);
});
