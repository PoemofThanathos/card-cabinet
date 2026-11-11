import { afterEach, beforeEach, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { CabinetDB } from '../src/db';
import { newCard, type Suggestions } from '../src/model';
import { applyImport, planImport, readPackage } from '../src/backup';
import { applyBatchReview, reviewPrefix, type BatchReview } from '../src/batch';

let db: CabinetDB;
beforeEach(async () => {
  db = new CabinetDB('review-import-' + crypto.randomUUID());
  await db.open();
});
afterEach(async () => {
  await db.delete();
});
const suggestions: Suggestions = {
  suggestions: [
    {
      field: 'name',
      value: 'Printed player',
      source: 'visible_text',
      evidence: 'Name on back',
      uncertain: false,
    },
    {
      field: 'year',
      value: '2026',
      source: 'inference',
      evidence: 'Year is not legible',
      uncertain: true,
    },
  ],
  warnings: ['Check front and back before applying.'],
};
function packageBlob(
  card = newCard(),
  reviews: unknown = [
    {
      cardId: card.id,
      result: suggestions,
      identificationOptions: { model: 'gpt-6-luna', reasoningEffort: 'high' },
    },
  ],
) {
  return new Blob([
    zipSync({
      'manifest.json': strToU8(
        JSON.stringify({
          format: 'card-cabinet',
          version: 1,
          exportedAt: new Date().toISOString(),
          cards: [card],
          photos: [],
          reviews,
        }),
      ),
    }) as Uint8Array<ArrayBuffer>,
  ]);
}
it('imports pending suggestions without changing fields, then applies only reviewed certain values', async () => {
  const pack = await readPackage(packageBlob());
  await applyImport(pack, await planImport(pack, db), db);
  const card = (await db.cards.toArray())[0];
  expect(card.fields.name).toBe('');
  const row = (await db.settings.where('key').startsWith(reviewPrefix).toArray())[0];
  expect((row.value as BatchReview).identificationOptions?.model).toBe('gpt-6-luna');
  await applyBatchReview(row.key, { name: 'Printed player', year: '2026' }, db);
  expect((await db.cards.get(card.id))?.fields.name).toBe('Printed player');
  expect((await db.cards.get(card.id))?.fields.year).toBe('');
  expect(await db.settings.where('key').startsWith(reviewPrefix).count()).toBe(0);
});
it('reimporting an unchanged card does not recreate a discarded review', async () => {
  const pack = await readPackage(packageBlob());
  await applyImport(pack, await planImport(pack, db), db);
  await db.settings.clear();
  await applyImport(pack, await planImport(pack, db), db);
  expect(await db.cards.count()).toBe(1);
  expect(await db.settings.count()).toBe(0);
});
it('rejects reviews for missing cards and duplicate suggestion fields', async () => {
  const card = newCard();
  await expect(
    readPackage(
      packageBlob(card, [
        {
          cardId: crypto.randomUUID(),
          result: suggestions,
          identificationOptions: { model: 'gpt-6-luna', reasoningEffort: 'high' },
        },
      ]),
    ),
  ).rejects.toThrow('Invalid identification reviews');
  await expect(
    readPackage(
      packageBlob(card, [
        {
          cardId: card.id,
          result: {
            ...suggestions,
            suggestions: [suggestions.suggestions[0], suggestions.suggestions[0]],
          },
          identificationOptions: { model: 'gpt-6-luna', reasoningEffort: 'high' },
        },
      ]),
    ),
  ).rejects.toThrow('Invalid identification reviews');
});
it('rolls back card import if review storage fails', async () => {
  const pack = await readPackage(packageBlob());
  db.settings.hook('creating', () => {
    throw new Error('full');
  });
  await expect(applyImport(pack, await planImport(pack, db), db)).rejects.toThrow('full');
  expect(await db.cards.count()).toBe(0);
  expect(await db.queue.count()).toBe(0);
});
