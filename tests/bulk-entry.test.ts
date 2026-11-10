import { afterEach, beforeEach, expect, it } from 'vitest';
import { CabinetDB, makePhoto, saveCard } from '../src/db';
import {
  type BulkEntryPlan,
  baseCardKey,
  baseSelection,
  bulkCard,
  cardNumbers,
  fileKey,
  fileReference,
  getBulkEntryPlan,
  manualRows,
  numberCount,
  pairPhotos,
  parseNumberRanges,
  saveBulkEntry,
  storeBulkEntryPlan,
  changeBulkEntry,
  validateSourceFiles,
} from '../src/bulk-entry';

let database: CabinetDB;
beforeEach(() => {
  database = new CabinetDB('bulk-' + crypto.randomUUID());
});
afterEach(async () => {
  await database.delete();
});
const common = {
  category: 'MLB',
  maker: 'Topps',
  product: 'Baseball card',
  set: 'Series 1',
  year: '2026',
};
const makePlan = (kind: BulkEntryPlan['kind'], numbers: string[]): BulkEntryPlan => ({
  id: crypto.randomUUID(),
  kind,
  entries: numbers.map((cardNumber) => ({
    card: bulkCard(common, { cardNumber }, kind === 'base'),
    state: 'pending',
  })),
});

it('pairs more than 100 photos in natural filename order without a count cap', () => {
  const files = Array.from({ length: 240 }, (_, i) => new File(['image'], `image${240 - i}.jpg`));
  const paired = pairPhotos(files, 'alternating');
  expect(paired).toHaveLength(120);
  expect(paired[0].map((f) => f.name)).toEqual(['image1.jpg', 'image2.jpg']);
  expect(paired.at(-1)?.map((f) => f.name)).toEqual(['image239.jpg', 'image240.jpg']);
  const split = pairPhotos(files, 'fronts-first');
  expect(split[0].map((f) => f.name)).toEqual(['image1.jpg', 'image121.jpg']);
  expect(() => pairPhotos(files.slice(1), 'alternating')).toThrow('even number');
});

it('merges overlapping base ranges and excludes missing cards without assuming parallel ownership', () => {
  expect(numberCount(parseNumberRanges('1-10, 5-12, 12, 15'))).toBe(13);
  const selection = baseSelection('1-150', 'missing', '2, 7, 147');
  expect(numberCount(selection.owned)).toBe(147);
  expect([...cardNumbers(selection.unrecorded!)]).toEqual(['2', '7', '147']);
  expect([...cardNumbers(selection.owned)]).not.toContain('7');
  const card = bulkCard(
    { ...common, rarity: 'Gold', autograph: 'Signed', memorabilia: 'Patch', serial: '1/5' },
    { cardNumber: '12' },
    true,
  );
  expect(card.fields).toMatchObject({ rarity: 'Base', autograph: '', memorabilia: '', serial: '' });
});

it('imports only confirmed owned numbers when the missing cards or checklist are unknown', () => {
  const selection = baseSelection('', 'owned', '2, 7, 147');
  expect([...cardNumbers(selection.owned)]).toEqual(['2', '7', '147']);
  expect(selection.unrecorded).toBeNull();
  expect(() => baseSelection('1-150', 'owned', '')).toThrow('confirmed');
  expect(() => baseSelection('1-150', 'missing', '151')).toThrow('outside');
  expect(() => parseNumberRanges('9-2')).toThrow('smaller');
  expect(() => parseNumberRanges('one')).toThrow('Use card numbers');
  expect(numberCount(baseSelection('1-3', 'complete', 'old invalid input').owned)).toBe(3);
});

it('parses manual rows with tabs or pipes and validates column counts', () => {
  expect(manualRows('大谷翔平 | 1 | Dodgers | Base\nPlayer B\t2\tTeam B\tGold')).toEqual([
    { name: '大谷翔平', cardNumber: '1', team: 'Dodgers', rarity: 'Base' },
    { name: 'Player B', cardNumber: '2', team: 'Team B', rarity: 'Gold' },
  ]);
  expect(() => manualRows('a|b|c|d|e')).toThrow('too many');
});

it('rejects ambiguous source file metadata instead of assigning the wrong photo', () => {
  const a = new File(['front'], 'card.jpg', { lastModified: 1 });
  const b = new File(['other'], 'card.jpg', { lastModified: 1 });
  expect(() => validateSourceFiles([a, b])).toThrow('same filename');
});

it('deduplicates owned base numbers while keeping parallels and relics separate', async () => {
  const base = bulkCard(common, { cardNumber: '００１' }, true);
  base.status = 'archived';
  const gold = bulkCard(common, { cardNumber: '2', rarity: 'Gold' });
  const relic = bulkCard(common, { cardNumber: '3', rarity: 'Base', memorabilia: 'Patch' });
  const unknown = bulkCard(common, { cardNumber: '4' });
  for (const card of [base, gold, relic, unknown]) await saveCard(card, [], database);
  expect(baseCardKey(gold)).toBeNull();
  expect(baseCardKey(relic)).toBeNull();
  expect(baseCardKey(unknown)).toBeNull();
  let plan = makePlan('base', ['1', '2', '3', '4']);
  await storeBulkEntryPlan(plan, database);
  for (let i = 0; i < plan.entries.length; i++)
    plan = await saveBulkEntry(plan, i, new Map(), database);
  expect(plan.entries.map((entry) => entry.state)).toEqual(['existing', 'saved', 'saved', 'saved']);
  expect(await database.cards.count()).toBe(7);
  const second = makePlan('base', ['1', '2', '3', '4']);
  await storeBulkEntryPlan(second, database);
  for (let i = 0; i < second.entries.length; i++)
    await saveBulkEntry(second, i, new Map(), database);
  expect(await database.cards.count()).toBe(7);
});

it('resumes a partially saved import without adding the completed card twice', async () => {
  let plan = makePlan('manual', ['1', '2', '3']);
  await storeBulkEntryPlan(plan, database);
  plan = await saveBulkEntry(plan, 0, new Map(), database);
  expect(await database.cards.count()).toBe(1);
  const restored = (await getBulkEntryPlan(database))!;
  for (let i = 0; i < restored.entries.length; i++)
    await saveBulkEntry(restored, i, new Map(), database);
  expect(await database.cards.count()).toBe(3);
  expect(await database.queue.count()).toBe(3);
});

it('keeps completed cards and leaves failed image pairs pending for reselection', async () => {
  const front = new File(['front'], 'front.jpg', { lastModified: 1 });
  const back = new File(['back'], 'back.jpg', { lastModified: 2 });
  let plan = makePlan('photos', ['1', '2']);
  for (const entry of plan.entries) entry.sources = [fileReference(front), fileReference(back)];
  const files = new Map([front, back].map((file) => [fileKey(file), file]));
  await storeBulkEntryPlan(plan, database);
  const encode = async (blob: Blob) => makePhoto(blob);
  plan = await saveBulkEntry(plan, 0, files, database, encode);
  await expect(saveBulkEntry(plan, 1, new Map(), database, encode)).rejects.toThrow('Reselect');
  expect(await database.cards.count()).toBe(1);
  expect((await getBulkEntryPlan(database))?.entries[1].state).toBe('pending');
  plan = await saveBulkEntry(plan, 1, files, database, encode);
  expect(await database.cards.count()).toBe(2);
  expect(plan.entries.every((entry) => entry.state === 'saved')).toBe(true);
});

it('does not overwrite a different import opened in another tab', async () => {
  const first = makePlan('manual', ['1']);
  const second = makePlan('manual', ['2']);
  await storeBulkEntryPlan(second, database);
  await expect(saveBulkEntry(first, 0, new Map(), database)).rejects.toThrow('another tab');
  expect(await database.cards.count()).toBe(0);
});

it('preserves concurrent progress and refuses a photo pairing changed during encoding', async () => {
  let plan = makePlan('photos', ['1', '2']);
  const front = new File(['front'], 'front.jpg', { lastModified: 1 });
  const back = new File(['back'], 'back.jpg', { lastModified: 2 });
  for (const entry of plan.entries) entry.sources = [fileReference(front), fileReference(back)];
  const files = new Map([front, back].map((file) => [fileKey(file), file]));
  await storeBulkEntryPlan(plan, database);
  plan = await saveBulkEntry(plan, 0, files, database, async (blob) => makePhoto(blob));
  await changeBulkEntry(plan.id, 0, 'skip', database);
  expect((await getBulkEntryPlan(database))?.entries[0].state).toBe('saved');
  let changed = false;
  await expect(
    saveBulkEntry(plan, 1, files, database, async (blob) => {
      if (!changed) {
        changed = true;
        await changeBulkEntry(plan.id, 1, 'swap', database);
      }
      return makePhoto(blob);
    }),
  ).rejects.toThrow('pairing changed');
  expect(await database.cards.count()).toBe(1);
  expect((await getBulkEntryPlan(database))?.entries[1].sources?.[0].name).toBe('back.jpg');
});
