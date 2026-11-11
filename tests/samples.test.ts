import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CabinetDB, changeStatus, duplicateCard, makePhoto, saveCard } from '../src/db';
import { copyCard, newCard, plainCard } from '../src/model';
import {
  addSampleCards,
  countSampleCards,
  isSampleCard,
  removeSampleCards,
  sampleCards,
} from '../src/samples';

let database: CabinetDB;
beforeEach(() => {
  database = new CabinetDB('samples-' + crypto.randomUUID());
});
afterEach(async () => {
  vi.restoreAllMocks();
  await database.delete();
});

it('recognizes sample originals and marked copies without treating a tag or name as proof', () => {
  const original = sampleCards()[0];
  const duplicate = copyCard(original);
  expect(isSampleCard(duplicate)).toBe(true);
  original.fields.notes = 'My edited description';
  original.fields.tags = '';
  expect(isSampleCard(original)).toBe(true);

  const tagOnly = newCard();
  tagOnly.fields.tags = 'test-card';
  expect(isSampleCard(tagOnly)).toBe(false);
  const noteOnly = copyCard(duplicate);
  noteOnly.fields.tags = '';
  expect(isSampleCard(noteOnly)).toBe(false);
  const sameName = copyCard(duplicate);
  sameName.fields.notes = '';
  sameName.fields.tags = '';
  expect(isSampleCard(sameName)).toBe(false);
});

it('soft-deletes active and archived samples and copies while preserving real cards and photos', async () => {
  await addSampleCards(database, async (card, side) =>
    makePhoto(new Blob([`${card.id}-${side}`], { type: 'image/jpeg' })),
  );
  const cards = await database.cards.toArray();
  const edited = cards[0];
  edited.fields.notes = 'My correction';
  edited.fields.tags = '';
  await saveCard(plainCard(edited), [], database);
  await changeStatus(cards[1], 'archived', database);
  const duplicate = await duplicateCard(cards[2], database);
  await changeStatus(duplicate, 'archived', database);
  await changeStatus(cards[3], 'deleted', database);

  const real = newCard();
  real.fields.name = cards[0].fields.name;
  real.fields.tags = 'test-card';
  real.photos = { ...cards[0].photos };
  await saveCard(real, [], database);
  const realBefore = await database.cards.get(real.id);
  const realQueueBefore = await database.queue.get(real.id);
  const deletedBefore = await database.cards.get(cards[3].id);
  const deletedQueueBefore = await database.queue.get(cards[3].id);
  const photosBefore = await database.photos.toArray();

  // Existing cloud revision and sync version must survive a normal queued deletion.
  await database.cards.update(edited.id, { baseRev: 7, syncedVersion: 2 });
  const sampleBefore = (await database.cards.get(edited.id))!;
  expect(await countSampleCards(database)).toBe(12);
  expect(await removeSampleCards(database)).toBe(12);
  expect(await countSampleCards(database)).toBe(0);
  expect(await database.cards.where('status').equals('deleted').count()).toBe(13);
  expect(await database.cards.get(real.id)).toEqual(realBefore);
  expect(await database.queue.get(real.id)).toEqual(realQueueBefore);
  expect(await database.cards.get(cards[3].id)).toEqual(deletedBefore);
  expect(await database.queue.get(cards[3].id)).toEqual(deletedQueueBefore);
  expect(await database.photos.toArray()).toEqual(photosBefore);

  const removed = (await database.cards.get(edited.id))!;
  expect(removed).toMatchObject({
    status: 'deleted',
    fields: sampleBefore.fields,
    photos: sampleBefore.photos,
    createdAt: sampleBefore.createdAt,
    baseRev: 7,
    syncedVersion: 2,
    localVersion: sampleBefore.localVersion + 1,
  });
  expect(await database.queue.get(edited.id)).toMatchObject({
    id: edited.id,
    baseRev: 7,
    version: removed.localVersion,
    card: plainCard(removed),
  });

  const cardsAfter = await database.cards.toArray();
  const queueAfter = await database.queue.toArray();
  expect(await removeSampleCards(database)).toBe(0);
  expect(await database.cards.toArray()).toEqual(cardsAfter);
  expect(await database.queue.toArray()).toEqual(queueAfter);
  expect(
    await addSampleCards(database, async () => {
      throw new Error('Deleted samples must not be recreated');
    }),
  ).toBe(0);

  await changeStatus(removed, 'active', database);
  const restored = (await database.cards.get(edited.id))!;
  expect(restored.status).toBe('active');
  expect(restored.fields).toEqual(sampleBefore.fields);
  expect(restored.photos).toEqual(sampleBefore.photos);
  expect(await database.photos.toArray()).toEqual(photosBefore);
  expect((await database.queue.get(edited.id))?.card.status).toBe('active');
  expect(await countSampleCards(database)).toBe(1);
});

it('rolls back the entire removal when a queued deletion cannot be saved', async () => {
  for (const card of sampleCards().slice(0, 2)) await saveCard(card, [], database);
  const cardsBefore = await database.cards.toArray();
  const queueBefore = await database.queue.toArray();
  const put = database.queue.put.bind(database.queue);
  let writes = 0;
  vi.spyOn(database.queue, 'put').mockImplementation((...args) => {
    if (++writes === 2) throw new Error('Queue storage unavailable');
    return put(...args);
  });
  await expect(removeSampleCards(database)).rejects.toThrow('Queue storage unavailable');
  expect(writes).toBe(2);
  expect(await database.cards.toArray()).toEqual(cardsBefore);
  expect(await database.queue.toArray()).toEqual(queueBefore);
  expect(await countSampleCards(database)).toBe(2);
});

it('does not queue duplicate deletions when two tabs remove samples together', async () => {
  for (const card of sampleCards().slice(0, 2)) await saveCard(card, [], database);
  const counts = await Promise.all([removeSampleCards(database), removeSampleCards(database)]);
  expect(counts.sort()).toEqual([0, 2]);
  for (const card of await database.cards.toArray()) {
    expect(card.status).toBe('deleted');
    expect(card.localVersion).toBe(2);
  }
});
