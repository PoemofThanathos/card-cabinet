import { afterEach, beforeEach, expect, it } from 'vitest';
import { CabinetDB, changeStatus, makePhoto, saveCard } from '../src/db';
import { groupCards } from '../src/groups';
import { newCard, plainCard } from '../src/model';
import { addSampleCards, sampleCards } from '../src/samples';

let database: CabinetDB;
beforeEach(() => {
  database = new CabinetDB('groups-' + crypto.randomUUID());
});
afterEach(async () => {
  await database.delete();
});

it('separates equal set names by maker, year and product, with one unassigned group', () => {
  const cards = sampleCards();
  expect(groupCards(cards, 'set')).toHaveLength(6);
  expect(groupCards(cards, 'set').map((group) => group.cards.length)).toEqual([2, 2, 2, 2, 2, 2]);
  const anotherYear = structuredClone(cards[0]);
  anotherYear.fields.year = '2026';
  expect(groupCards([...cards, anotherYear], 'set')).toHaveLength(7);
  const unknown = newCard();
  const unknown2 = newCard();
  unknown2.fields.maker = 'BBM';
  expect(groupCards([unknown, unknown2], 'set')).toMatchObject([
    { name: 'No set', cards: [unknown, unknown2] },
  ]);
});

it('groups players across sets, normalizes names and supports Japanese-only names', () => {
  const cards = sampleCards();
  cards[6].fields.name = '  Ｓｈｏｈｅｉ   OHTANI  ';
  const players = groupCards(cards, 'player');
  expect(players).toHaveLength(6);
  expect(players.find((player) => player.name === 'Shohei Ohtani')).toMatchObject({
    setCount: 2,
    cards: [cards[0], cards[6]],
  });
  const japanese = newCard();
  japanese.fields.japaneseName = '大谷翔平';
  expect(groupCards([japanese], 'player')[0].name).toBe('大谷翔平');
});

it('adds test cards once without replacing edits or restoring deleted cards', async () => {
  const photo = await makePhoto(new Blob(['sample'], { type: 'image/jpeg' }));
  expect(await addSampleCards(database, async () => photo)).toBe(12);
  const cards = await database.cards.toArray();
  cards[0].fields.notes = 'My correction';
  await saveCard(plainCard(cards[0]), [], database);
  await changeStatus(cards[1], 'deleted', database);
  const queueBefore = await database.queue.toArray();
  expect(
    await addSampleCards(database, async () => {
      throw new Error('Should not render twice');
    }),
  ).toBe(0);
  expect(await database.cards.count()).toBe(12);
  expect((await database.cards.get(cards[0].id))?.fields.notes).toBe('My correction');
  expect((await database.cards.get(cards[1].id))?.status).toBe('deleted');
  expect(await database.queue.toArray()).toEqual(queueBefore);
});

it('leaves existing data intact if sample artwork fails', async () => {
  const existing = newCard();
  await saveCard(existing, [], database);
  let calls = 0;
  const photo = await makePhoto(new Blob(['sample'], { type: 'image/jpeg' }));
  await expect(
    addSampleCards(database, async () => {
      if (++calls === 3) throw new Error('Storage unavailable');
      return photo;
    }),
  ).rejects.toThrow('Storage unavailable');
  expect(await database.cards.count()).toBe(1);
  expect(await database.photos.count()).toBe(0);
  expect(await database.queue.count()).toBe(1);
});
