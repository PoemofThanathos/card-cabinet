import Dexie, { type EntityTable, type Table } from 'dexie';
import {
  type Card,
  type LocalCard,
  type Operation,
  type Conflict,
  type Draft,
  type RemoteCard,
  plainCard,
  cardSchema,
  copyCard,
  sameCard,
  purgedCard,
} from './model';

export type Photo = { hash: string; bytes: ArrayBuffer; type: string; size: number };
export type PhotoDisplay = {
  hash: string;
  version: 1;
  mode: 'auto' | 'original' | 'manual';
  rotation: number;
  crop: { left: number; top: number; right: number; bottom: number };
  bytes?: ArrayBuffer;
  type?: string;
  updatedAt: number;
};
export const photoBlob = (photo: Photo) => new Blob([photo.bytes], { type: photo.type });
export class CabinetDB extends Dexie {
  cards!: EntityTable<LocalCard, 'id'>;
  photos!: EntityTable<Photo, 'hash'>;
  photoDisplays!: EntityTable<PhotoDisplay, 'hash'>;
  queue!: EntityTable<Operation, 'id'>;
  conflicts!: EntityTable<Conflict, 'id'>;
  settings!: EntityTable<{ key: string; value: unknown }, 'key'>;
  constructor(name = 'card-cabinet') {
    super(name);
    this.version(1).stores({
      cards: 'id,status,updatedAt',
      photos: 'hash',
      queue: 'id',
      settings: 'key',
    });
    this.version(2)
      .stores({ conflicts: 'id' })
      .upgrade(async (tx) => {
        await tx
          .table('cards')
          .toCollection()
          .modify((c) => {
            c.localVersion ??= 1;
            c.syncedVersion ??= 0;
            c.baseRev ??= 0;
          });
      });
    this.version(3)
      .stores({})
      .upgrade(async (tx) => {
        for (const row of await tx.table('photos').toArray()) {
          if (row.blob && !row.bytes) {
            row.bytes = await Dexie.waitFor(row.blob.arrayBuffer());
            delete row.blob;
            await tx.table('photos').put(row);
          }
        }
      });
    this.version(4).stores({ photoDisplays: 'hash,updatedAt' });
  }
}
export const db = new CabinetDB();
export async function setting<T>(key: string, fallback: T, database = db): Promise<T> {
  return ((await database.settings.get(key))?.value as T) ?? fallback;
}
export async function setSetting(key: string, value: unknown, database = db) {
  if (key === 'draft' && value) {
    const draft = value as Draft;
    await database.transaction('rw', database.settings, database.cards, async () => {
      for (const card of [draft.card, draft.base]) {
        if (
          card &&
          (card.status === 'purged' || (await database.cards.get(card.id))?.status === 'purged')
        )
          throw new Error('This card was permanently deleted. Its draft cannot be saved.');
      }
      await database.settings.put({ key, value });
    });
    return;
  }
  await database.settings.put({ key, value });
}
export async function saveCard(input: Card, photos: Photo[] = [], database = db, expected?: Card) {
  const card = cardSchema.parse({ ...input, updatedAt: new Date().toISOString() });
  const tables: Table[] = [database.cards, database.photos, database.queue];
  if (card.status === 'purged')
    tables.push(database.settings, database.conflicts, database.photoDisplays);
  await database.transaction('rw', tables, async () => {
    const old = await database.cards.get(card.id);
    if (old?.status === 'purged') {
      if (card.status === 'purged') return;
      throw new Error('This card was permanently deleted. It cannot be restored.');
    }
    if (expected && old && !sameCard(old, expected))
      throw new Error(
        'This card changed in another tab or sync. Your draft is kept. Close the editor and compare the latest card before replacing its draft.',
      );
    const version = (old?.localVersion ?? 0) + 1;
    if (photos.length && card.status !== 'purged') await database.photos.bulkPut(photos);
    const candidates = new Set<string>();
    if (card.status === 'purged') {
      collectPhotoReferences(old, candidates);
      collectPhotoReferences(await database.queue.get(card.id), candidates);
    }
    await database.cards.put({
      ...card,
      baseRev: old?.baseRev ?? 0,
      localVersion: version,
      syncedVersion: old?.syncedVersion ?? 0,
    });
    await database.queue.put({
      id: card.id,
      mutationId: crypto.randomUUID(),
      baseRev: old?.baseRev ?? 0,
      version,
      card,
    });
    if (card.status === 'purged') await clearPurgedCardArtifacts([card.id], candidates, database);
  });
}
export async function duplicateCard(card: Card, database = db) {
  return database.transaction('rw', database.cards, database.photos, database.queue, async () => {
    if ((await database.cards.get(card.id))?.status === 'purged')
      throw new Error('This card was permanently deleted. It cannot be duplicated.');
    const copy = copyCard(plainCard(card));
    await saveCard(copy, [], database);
    return copy;
  });
}
export async function changeStatus(card: Card, status: Card['status'], database = db) {
  await saveCard({ ...plainCard(card), status }, [], database);
}

function collectPhotoReferences(value: unknown, hashes: Set<string>) {
  const pending: unknown[] = [value];
  const seen = new Set<object>();
  while (pending.length) {
    const current = pending.pop();
    if (!current || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current);
    if (ArrayBuffer.isView(current) || current instanceof ArrayBuffer || current instanceof Blob)
      continue;
    const object = current as Record<string, unknown>;
    const photos = object.photos as { front?: unknown; back?: unknown } | undefined;
    if (photos && typeof photos === 'object')
      for (const hash of [photos.front, photos.back])
        if (typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash)) hashes.add(hash);
    const localPhotos = object.localPhotos;
    if (localPhotos && typeof localPhotos === 'object' && !Array.isArray(localPhotos))
      for (const hash of Object.values(localPhotos))
        if (typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash)) hashes.add(hash);
    for (const child of Object.values(object)) pending.push(child);
  }
}

/** Call inside a transaction covering cards, photos, queue, settings and conflicts. */
const purgePhotoCandidatesKey = 'purgePhotoCandidates';

async function clearPurgedCardArtifacts(
  ids: string[],
  candidates: Set<string>,
  database: CabinetDB,
  deferPhotos = false,
) {
  const purged = new Set(ids);
  for (const conflict of await database.conflicts.bulkGet(ids)) {
    if (conflict) collectPhotoReferences(conflict, candidates);
  }
  await database.conflicts.bulkDelete(ids);
  for (const row of await database.settings.toArray()) {
    const value = row.value as {
      card?: Card;
      base?: Card | null;
      failures?: { cardId: string }[];
    } | null;
    const matchesCard = value?.card && purged.has(value.card.id);
    const matchesDraft =
      row.key === 'draft' && (matchesCard || (value?.base && purged.has(value.base.id)));
    if (matchesDraft || (row.key.startsWith('aiBatchReview:') && matchesCard)) {
      collectPhotoReferences(row.value, candidates);
      await database.settings.delete(row.key);
    } else if (row.key.startsWith('bulkEntry:') && matchesCard) {
      collectPhotoReferences(row.value, candidates);
      await database.settings.put({
        key: row.key,
        value: { card: purgedCard(value!.card!), state: 'skipped' },
      });
    } else if (
      row.key === 'aiBatch' &&
      value?.failures?.some((failure) => purged.has(failure.cardId))
    ) {
      await database.settings.put({
        key: row.key,
        value: {
          ...value,
          failures: value.failures.filter((failure) => !purged.has(failure.cardId)),
          error: '',
        },
      });
    }
  }
  if (!candidates.size) return;
  const pending = await setting<string[]>(purgePhotoCandidatesKey, [], database);
  if (deferPhotos) {
    await database.settings.put({
      key: purgePhotoCandidatesKey,
      value: [...new Set([...pending, ...candidates])],
    });
    return;
  }
  for (const hash of pending) candidates.delete(hash);
  await deleteUnreferencedPhotos(candidates, database);
}

async function deleteUnreferencedPhotos(candidates: Set<string>, database: CabinetDB) {
  const referenced = new Set<string>();
  await database.cards.each((card) => collectPhotoReferences(card, referenced));
  await database.queue.each((operation) => collectPhotoReferences(operation, referenced));
  await database.settings.each((row) => collectPhotoReferences(row.value, referenced));
  await database.conflicts.each((conflict) => collectPhotoReferences(conflict, referenced));
  const unused = [...candidates].filter((hash) => !referenced.has(hash));
  await database.photos.bulkDelete(unused);
  await database.photoDisplays.bulkDelete(unused);
}

/** Finalize remote photo cleanup only after a complete successful cloud pull. */
export async function collectPurgedPhotos(database: CabinetDB = db) {
  await database.transaction(
    'rw',
    [
      database.cards,
      database.photos,
      database.queue,
      database.settings,
      database.conflicts,
      database.photoDisplays,
    ],
    async () => {
      const candidates = await setting<string[]>(purgePhotoCandidatesKey, [], database);
      if (!candidates.length) return;
      await deleteUnreferencedPhotos(new Set(candidates), database);
      await database.settings.delete(purgePhotoCandidatesKey);
    },
  );
}

export async function purgeDeletedCards(ids: string[], database: CabinetDB = db): Promise<number> {
  return database.transaction(
    'rw',
    [
      database.cards,
      database.photos,
      database.queue,
      database.settings,
      database.conflicts,
      database.photoDisplays,
    ],
    async () => {
      const cards = (await database.cards.bulkGet([...new Set(ids)])).filter(
        (card): card is LocalCard => card?.status === 'deleted',
      );
      const candidates = new Set<string>();
      for (const local of cards) {
        collectPhotoReferences(local, candidates);
        collectPhotoReferences(await database.queue.get(local.id), candidates);
        const card = purgedCard(local);
        const version = local.localVersion + 1;
        await database.cards.put({
          ...card,
          baseRev: local.baseRev,
          localVersion: version,
          syncedVersion: local.syncedVersion,
        });
        await database.queue.put({
          id: card.id,
          mutationId: crypto.randomUUID(),
          baseRev: local.baseRev,
          version,
          card,
        });
      }
      if (cards.length)
        await clearPurgedCardArtifacts(
          cards.map((card) => card.id),
          candidates,
          database,
        );
      return cards.length;
    },
  );
}

/** A remote purge is terminal even when this device has unsynced edits. */
export async function acceptRemotePurge(
  remote: RemoteCard,
  database: CabinetDB = db,
  deferPhotos = false,
) {
  if (remote.card.status !== 'purged') throw new Error('Expected a permanent deletion record.');
  const card = cardSchema.parse(remote.card);
  await database.transaction(
    'rw',
    [
      database.cards,
      database.photos,
      database.queue,
      database.settings,
      database.conflicts,
      database.photoDisplays,
    ],
    async () => {
      const local = await database.cards.get(card.id);
      const candidates = new Set<string>();
      collectPhotoReferences(local, candidates);
      collectPhotoReferences(await database.queue.get(card.id), candidates);
      const version = local?.localVersion ?? 1;
      await database.cards.put({
        ...card,
        baseRev: Math.max(local?.baseRev ?? 0, remote.rev),
        localVersion: version,
        syncedVersion: version,
      });
      await database.queue.delete(card.id);
      await clearPurgedCardArtifacts([card.id], candidates, database, deferPhotos);
    },
  );
}
export async function photoHash(blob: Blob) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))]
    .map((v) => v.toString(16).padStart(2, '0'))
    .join('');
}
export async function makePhoto(blob: Blob): Promise<Photo> {
  return {
    hash: await photoHash(blob),
    bytes: await blob.arrayBuffer(),
    type: blob.type,
    size: blob.size,
  };
}
export function friendlyError(error: unknown) {
  const e = error as { name?: string; code?: string; message?: string };
  if (e?.name === 'QuotaExceededError' || e?.message?.includes('QuotaExceeded'))
    return 'Device storage is full. Your previous saved cards are intact. Export a backup, free space, then try again.';
  if (e?.code?.includes('permission-denied'))
    return 'Sync permission denied. Check your UID and Firestore rules. Your local collection is still available.';
  if (e?.code?.includes('resource-exhausted'))
    return 'Cloud quota reached. Keep working locally and try sync after the quota resets.';
  if (e?.code?.includes('auth/'))
    return 'Sign-in failed or expired. Check your credentials and connection. Local cards are still available.';
  return e?.message || 'The operation could not finish. Your saved collection is still available.';
}
