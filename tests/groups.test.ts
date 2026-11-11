import { afterEach, beforeEach, expect, it } from 'vitest';
import { CabinetDB, changeStatus, makePhoto, saveCard } from '../src/db';
import { groupCards, groupKey } from '../src/groups';
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

function groupedCard(values: Partial<ReturnType<typeof newCard>['fields']> = {}) {
  const card = newCard();
  Object.assign(card.fields, {
    category: 'MLB',
    maker: 'Topps',
    year: '2026',
    set: 'Series 1',
    ...values,
  });
  return card;
}

it('groups a release into base, parallels, inserts, relics and unclassified cards', () => {
  const cards = [
    groupedCard({ rarity: 'Base' }),
    groupedCard({ set: '2026 Topps Baseball Series One Base', product: 'Baseball card' }),
    groupedCard({ rarity: 'Gold', serial: '12/50' }),
    groupedCard({ set: '2026 Topps Series 1 - 1991 Topps Baseball All-Stars', rarity: 'Insert' }),
    groupedCard({ autograph: 'Blue handwritten signature' }),
    groupedCard({ memorabilia: 'Fabric swatch', rarity: 'Gold' }),
    groupedCard({ serial: '04/25' }),
  ];
  const groups = groupCards(cards, 'set');
  expect(groups.map((g) => g.name)).toEqual([
    '2026 Topps Series 1 · Base',
    '2026 Topps Series 1 · Inserts',
    '2026 Topps Series 1 · Parallels',
    '2026 Topps Series 1 · Relics & autos',
    '2026 Topps Series 1 · Unclassified',
  ]);
  expect(groups.map((g) => g.cards.length)).toEqual([2, 1, 1, 2, 1]);
  for (const group of groups)
    for (const card of group.cards) expect(groupKey(card, 'set')).toBe(group.key);
  for (const card of cards) card.fields.name = 'Same player';
  expect(groupCards(cards, 'player')[0].setCount).toBe(1);
});

it('keeps the two EPOCH Time to Shine cards together despite product and serial differences', () => {
  const common = {
    category: 'Japanese baseball',
    maker: 'EPOCH',
    year: '2026',
    set: 'EPOCH 2026 Hiroshima Toyo Carp Premier Edition - Time to Shine',
  };
  const a = groupedCard({ ...common, product: 'Baseball card' });
  const b = groupedCard({ ...common, category: '', serial: '52/75' });
  const before = structuredClone([a, b]);
  expect(groupCards([a, b], 'set')).toMatchObject([
    {
      name: '2026 EPOCH Hiroshima Toyo Carp Premier Edition · Inserts',
      cards: [a, b],
    },
  ]);
  expect([a, b]).toEqual(before);
});

it('keeps the release year separate from the retro design year', () => {
  const card = groupedCard({
    set: '2026 Topps Series 2 - 1991 Topps Baseball Chrome All-Stars',
    rarity: 'Insert',
    cardNumber: '91ASC-13',
  });
  expect(groupCards([card], 'set')[0].name).toBe('2026 Topps Series 2 · Inserts');
  expect(card.fields.set).toBe('2026 Topps Series 2 - 1991 Topps Baseball Chrome All-Stars');
});

it('retains distinct releases, years, makers, leagues, products and unknown subtitles', () => {
  const cards = [
    groupedCard({ rarity: 'Base' }),
    groupedCard({ set: 'Series 2', rarity: 'Base' }),
    groupedCard({ year: '2025', rarity: 'Base' }),
    groupedCard({ maker: 'Panini', rarity: 'Base' }),
    groupedCard({ category: 'Japanese baseball', rarity: 'Base' }),
    groupedCard({ product: 'Weiss Schwarz', rarity: 'Base' }),
    groupedCard({ set: 'Series 1 - Mystery Edition', rarity: 'Base' }),
    groupedCard({ set: 'Series 1 Chrome', rarity: 'Base' }),
  ];
  expect(groupCards(cards, 'set')).toHaveLength(cards.length);
});

it('does not treat no autograph, a facsimile or an unexplained serial number as an autograph or parallel', () => {
  const cards = [
    groupedCard({ autograph: 'No visible autograph', memorabilia: 'None visible' }),
    groupedCard({ autograph: 'Printed facsimile signature', serial: '42/99' }),
    groupedCard({ rarity: 'Unknown' }),
  ];
  expect(groupCards(cards, 'set')).toMatchObject([
    { name: '2026 Topps Series 1 · Unclassified', cards },
  ]);
});

it('uses only explicit parallel evidence ahead of a known insert title', () => {
  const base = groupedCard({
    set: '2026 Topps Series 2 - 1991 Topps Baseball Chrome All-Stars',
    serial: '50/75',
  });
  const parallel = groupedCard({ ...base.fields, rarity: 'Gold refractor' });
  expect(groupCards([base, parallel], 'set').map((g) => g.name)).toEqual([
    '2026 Topps Series 2 · Inserts',
    '2026 Topps Series 2 · Parallels',
  ]);
});

it('fills missing category only for an explicit NPB release and preserves conflicting or unknown categories', () => {
  const known = groupedCard({ category: 'Japanese baseball', set: 'Topps NPB', rarity: 'Base' });
  const missing = groupedCard({ category: '', set: 'Topps NPB', rarity: 'Base' });
  const explicitMlb = groupedCard({ category: 'MLB', set: 'Topps NPB', rarity: 'Base' });
  expect(groupKey(known, 'set')).toBe(groupKey(missing, 'set'));
  expect(groupKey(known, 'set')).not.toBe(groupKey(explicitMlb, 'set'));
  const unidentified = groupedCard({ category: '', set: 'Stadium Club', rarity: 'Base' });
  const mlb = groupedCard({ category: 'MLB', set: 'Stadium Club', rarity: 'Base' });
  const npb = groupedCard({ category: 'Japanese baseball', set: 'Stadium Club', rarity: 'Base' });
  expect(groupCards([unidentified, mlb, npb], 'set')).toHaveLength(3);
});
