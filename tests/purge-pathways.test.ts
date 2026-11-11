import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { CabinetDB, makePhoto, purgeDeletedCards, saveCard, setting, type Photo } from '../src/db';
import { newCard, plainCard, purgedCard, type Card, type Suggestions } from '../src/model';
import {
  applyImport,
  assertExportAvailable,
  csvExport,
  exportPackage,
  planImport,
  readPackage,
} from '../src/backup';
import {
  baseCardKey,
  getBulkEntryPlan,
  saveBulkEntry,
  storeBulkEntryPlan,
  type BulkEntryPlan,
} from '../src/bulk-entry';
import {
  applyBatchReview,
  batchKey,
  createBatch,
  reviewPrefix,
  runBatch,
  type IdentificationBatch,
} from '../src/batch';

let database: CabinetDB;
beforeEach(async () => {
  database = new CabinetDB('purge-paths-' + crypto.randomUUID());
  await database.settings.put({ key: 'aiUnlimited', value: true });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await database.delete();
});
const photo = () =>
  makePhoto(new Blob([new Uint8Array([255, 216, 1, 2, 255, 217])], { type: 'image/jpeg' }));
async function savedCard(name = 'Private card') {
  const image = await photo();
  const card = newCard();
  card.fields.name = name;
  card.photos = { front: image.hash, back: image.hash };
  await saveCard(card, [image], database);
  return plainCard((await database.cards.get(card.id))!);
}
async function purge(card: Card) {
  await saveCard({ ...card, status: 'deleted' }, [], database);
  await purgeDeletedCards([card.id], database);
}
const options = () => ({
  database,
  ready: async () => {},
  lock: async <T>(action: () => Promise<T>) => action(),
  wait: async () => {},
});
const suggestions: Suggestions = {
  suggestions: [
    {
      field: 'name',
      value: 'Private suggestion',
      source: 'visible_text',
      evidence: 'Private card',
      uncertain: false,
    },
  ],
  warnings: [],
};

it('excludes tombstones and stale card snapshots from backups and CSV', async () => {
  const old = await savedCard();
  const live = await savedCard('Keep this card');
  await purge(old);
  const tombstone = plainCard((await database.cards.get(old.id))!);
  const pack = await readPackage(await exportPackage([old, tombstone, live], database));
  expect(pack.cards.map((card) => card.id)).toEqual([live.id]);
  expect(csvExport([tombstone, live])).not.toContain(old.id);
  expect(csvExport([tombstone, live])).toContain(live.id);
  await expect(assertExportAvailable([old.id], database)).rejects.toThrow('permanently deleted');
});

it('discards a backup being prepared if a card is purged while its photos are read', async () => {
  const old = await savedCard();
  const photos = database.photos as unknown as {
    get: (hash: string) => Promise<Photo | undefined>;
  };
  const get = photos.get.bind(photos);
  vi.spyOn(photos, 'get').mockImplementationOnce(async (key) => {
    const image = await get(key);
    await purge(old);
    return image;
  });
  await expect(exportPackage([old], database)).rejects.toThrow('permanently deleted');
});

it('skips a purged backup ID and its photos, allowing only an explicit new copy', async () => {
  const old = await savedCard();
  const pack = await readPackage(await exportPackage([old], database));
  const stale = await planImport(pack, database);
  await purge(old);
  await expect(applyImport(pack, stale, database)).rejects.toThrow('permanently deleted');
  const rows = await planImport(pack, database);
  expect(rows[0]).toMatchObject({ kind: 'purged', choice: 'keep' });
  await applyImport(pack, rows, database);
  expect(await database.photos.count()).toBe(0);
  expect(await database.cards.count()).toBe(1);
  rows[0].choice = 'replace';
  await expect(applyImport(pack, rows, database)).rejects.toThrow('permanently deleted');
  rows[0].choice = 'copy';
  await applyImport(pack, rows, database);
  const cards = await database.cards.toArray();
  expect(cards.find((card) => card.id === old.id)?.status).toBe('purged');
  expect(cards.find((card) => card.id !== old.id)).toMatchObject({
    status: 'active',
    fields: { name: old.fields.name },
  });
  expect(await database.photos.count()).toBe(1);
  await applyImport(pack, await planImport(pack, database), database);
  expect(await database.cards.count()).toBe(2);
});

it('rejects incoming permanent-deletion markers as backup content', async () => {
  const tombstone = purgedCard(newCard());
  const zip = zipSync({
    'manifest.json': strToU8(
      JSON.stringify({
        format: 'card-cabinet',
        version: 1,
        exportedAt: new Date().toISOString(),
        cards: [tombstone],
        photos: [],
      }),
    ),
  });
  await expect(readPackage(new Blob([zip as Uint8Array<ArrayBuffer>]))).rejects.toThrow(
    'Permanent-deletion records',
  );
  await expect(
    planImport({ cards: [tombstone], photos: [], missing: [] }, database),
  ).rejects.toThrow('Permanent-deletion records');
});

it('scrubs a stale bulk snapshot instead of restoring a purged card or its source filenames', async () => {
  const old = await savedCard();
  const plan: BulkEntryPlan = {
    id: crypto.randomUUID(),
    kind: 'photos',
    entries: [
      {
        card: old,
        state: 'pending',
        sources: [
          { name: 'private-front.jpg', size: 1, lastModified: 0 },
          { name: 'private-back.jpg', size: 1, lastModified: 0 },
        ],
      },
    ],
  };
  await storeBulkEntryPlan(plan, database);
  await purge(old);
  await storeBulkEntryPlan(plan, database);
  const resumed = (await getBulkEntryPlan(database))!;
  expect(resumed.entries[0]).toEqual({
    card: expect.objectContaining({
      status: 'purged',
      fields: expect.objectContaining({ name: '' }),
    }),
    state: 'skipped',
  });
  expect(baseCardKey(resumed.entries[0].card)).toBeNull();
  expect(JSON.stringify(await database.settings.toArray())).not.toContain('private-front');
  expect(JSON.stringify(await database.settings.toArray())).not.toContain('Private card');
});

it('does not save encoded photos or metadata if a bulk card is purged during conversion', async () => {
  const old = await savedCard();
  const sources = [
    new File(['f'], 'front.jpg', { lastModified: 0 }),
    new File(['b'], 'back.jpg', { lastModified: 0 }),
  ];
  const references = sources.map((file) => ({
    name: file.name,
    size: file.size,
    lastModified: file.lastModified,
  }));
  const plan: BulkEntryPlan = {
    id: crypto.randomUUID(),
    kind: 'photos',
    entries: [{ card: old, state: 'pending', sources: [references[0], references[1]] }],
  };
  await storeBulkEntryPlan(plan, database);
  const encode = vi.fn(async () => {
    if (encode.mock.calls.length === 1) await purge(old);
    return photo();
  });
  const files = new Map(
    sources.map((file) => [JSON.stringify([file.name, file.size, file.lastModified]), file]),
  );
  const resumed = await saveBulkEntry(plan, 0, files, database, encode);
  expect(resumed.entries[0].state).toBe('skipped');
  expect(resumed.entries[0].card.status).toBe('purged');
  expect(await database.photos.count()).toBe(0);
  expect((await database.cards.get(old.id))?.fields.name).toBe('');
});

it.each(['success', 'error'] as const)(
  'drops in-flight identification %s data after a purge',
  async (outcome) => {
    const old = await savedCard();
    const batch = await createBatch([old.id], options());
    const result = await runBatch(batch.id, {
      ...options(),
      identifyCard: async () => {
        await purge(old);
        if (outcome === 'error') throw new Error('Private request failure');
        return suggestions;
      },
    });
    expect(result.position).toBe(1);
    expect(await database.settings.where('key').startsWith(reviewPrefix).count()).toBe(0);
    expect(JSON.stringify(await database.settings.toArray())).not.toContain('Private');
    expect((await database.cards.get(old.id))?.status).toBe('purged');
  },
);

it('skips a purged queued card and continues with available cards', async () => {
  const old = await savedCard();
  const live = await savedCard('Current card');
  const batch = await createBatch([old.id, live.id], options());
  await purge(old);
  const identifyCard = vi.fn(async (_card: Card) => suggestions);
  const result = await runBatch(batch.id, { ...options(), identifyCard });
  expect(identifyCard).toHaveBeenCalledTimes(1);
  expect(identifyCard.mock.calls[0][0].id).toBe(live.id);
  expect(result.status).toBe('complete');
  expect(
    (await setting<IdentificationBatch | null>(batchKey, null, database))?.failures[0].name,
  ).toBe('Permanently deleted card');
});

it('removes an obsolete review rather than applying it to a purged ID', async () => {
  const old = await savedCard();
  await purge(old);
  const key = reviewPrefix + 'obsolete:' + old.id;
  await database.settings.put({
    key,
    value: { batchId: 'obsolete', card: old, result: suggestions },
  });
  await expect(applyBatchReview(key, { name: 'Private suggestion' }, database)).rejects.toThrow(
    'permanently deleted',
  );
  expect(await database.settings.get(key)).toBeUndefined();
  expect((await database.cards.get(old.id))?.fields.name).toBe('');
});
