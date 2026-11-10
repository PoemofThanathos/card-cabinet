import Dexie, { type EntityTable } from 'dexie';
import {
  type Card,
  type LocalCard,
  type Operation,
  type Conflict,
  plainCard,
  cardSchema,
  copyCard,
  sameCard,
} from './model';

export type Photo = { hash: string; bytes: ArrayBuffer; type: string; size: number };
export const photoBlob = (photo: Photo) => new Blob([photo.bytes], { type: photo.type });
export class CabinetDB extends Dexie {
  cards!: EntityTable<LocalCard, 'id'>;
  photos!: EntityTable<Photo, 'hash'>;
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
  }
}
export const db = new CabinetDB();
export async function setting<T>(key: string, fallback: T, database = db): Promise<T> {
  return ((await database.settings.get(key))?.value as T) ?? fallback;
}
export async function setSetting(key: string, value: unknown, database = db) {
  await database.settings.put({ key, value });
}
export async function saveCard(input: Card, photos: Photo[] = [], database = db, expected?: Card) {
  const card = cardSchema.parse({ ...input, updatedAt: new Date().toISOString() });
  await database.transaction('rw', database.cards, database.photos, database.queue, async () => {
    const old = await database.cards.get(card.id);
    if (expected && old && !sameCard(old, expected))
      throw new Error(
        'This card changed in another tab or sync. Your draft is kept. Close the editor and compare the latest card before replacing its draft.',
      );
    const version = (old?.localVersion ?? 0) + 1;
    if (photos.length) await database.photos.bulkPut(photos);
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
  });
}
export async function duplicateCard(card: Card, database = db) {
  const copy = copyCard(plainCard(card));
  await saveCard(copy, [], database);
  return copy;
}
export async function changeStatus(card: Card, status: Card['status'], database = db) {
  await saveCard({ ...plainCard(card), status }, [], database);
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
