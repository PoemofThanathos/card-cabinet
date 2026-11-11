import { test, expect } from '@playwright/test';
import { copyFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

test('stored matching photos reopen without reselection and remain drafts until paired and saved', async ({
  page,
}, testInfo) => {
  let requests = 0;
  page.on('request', (request) => {
    if (request.url().endsWith('/identify')) requests++;
  });
  await page.goto('./');
  await expect(page.getByRole('heading', { name: 'Your collection', exact: true })).toBeVisible();
  const bytes = readFileSync(path.resolve('tests/fixtures/card.jpg'));
  const hash = createHash('sha256').update(bytes).digest('hex');
  await page.evaluate(
    async ({ bytes, hash }) => {
      const files = ['front.jpg', 'back.jpg', 'unmatched.jpg'].map((name) => ({
        name,
        size: bytes.length,
        lastModified: 1234,
      }));
      const key = (source: (typeof files)[number]) =>
        JSON.stringify([source.name, source.size, source.lastModified]);
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('card-cabinet');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      await new Promise<void>((resolve, reject) => {
        const tx = database.transaction(['settings', 'photos'], 'readwrite');
        tx.objectStore('photos').put({
          hash,
          bytes: new Uint8Array(bytes).buffer,
          size: bytes.length,
          type: 'image/jpeg',
        });
        tx.objectStore('settings').put({
          key: 'aiPhotoMatching',
          value: {
            version: 1,
            id: 'local-matching-draft',
            files,
            identificationOptions: { model: 'gpt-6-luna', reasoningEffort: 'low' },
            cursor: files.length,
            nextCursor: files.length,
            inFlight: [],
            processing: null,
            status: 'complete',
            lastAttemptAt: 0,
            notBefore: 0,
            error: '',
            localPhotos: Object.fromEntries(files.map((source) => [key(source), hash])),
            results: Object.fromEntries(
              files.map((source, index) => [
                key(source),
                {
                  analysis: {
                    side: index === 0 ? 'front' : index === 1 ? 'back' : 'unknown',
                    name: index < 2 ? 'Printed player' : '',
                    maker: 'Printed maker',
                    set: '',
                    year: '',
                    cardNumber: '',
                    variant: '',
                    serial: '',
                    evidence: 'Printed details.',
                    warnings: [],
                  },
                },
              ]),
            ),
          },
        });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      database.close();
    },
    { bytes: [...bytes], hash },
  );
  await page.reload();
  await page.getByRole('button', { name: 'Bulk add', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Bulk add', exact: true });
  await dialog.getByRole('button', { name: 'Resume AI photo matching', exact: true }).click();
  await expect(
    dialog.getByRole('heading', { name: '1 proposed pair · 1 unmatched photo', exact: true }),
  ).toBeVisible();
  await expect(dialog.getByAltText('Selected front photo', { exact: true })).toBeVisible();
  await expect(dialog.getByAltText('Selected back photo', { exact: true })).toBeVisible();
  await expect(
    dialog.getByText(
      'Draft photos are stored on this device. They are not included in card backups until saved as cards.',
      { exact: true },
    ),
  ).toBeVisible();
  await expect(dialog.getByText('Reselect photo', { exact: true })).toHaveCount(0);
  expect(requests).toBe(0);
  await page.screenshot({ path: testInfo.outputPath('local-matching-draft.png'), fullPage: true });
  await dialog.getByRole('button', { name: 'Use 1 pair', exact: true }).click();
  await dialog.getByRole('button', { name: 'Close and resume later', exact: true }).click();
  await page.getByRole('button', { name: /^All cards/ }).click();
  await expect(page.locator('.collection-card')).toHaveCount(0);

  await page.reload();
  await page.getByRole('button', { name: 'Bulk add', exact: true }).click();
  await expect(dialog.getByAltText('Selected front photo', { exact: true })).toBeVisible();
  await expect(dialog.getByAltText('Selected back photo', { exact: true })).toBeVisible();
  await expect(dialog.getByText('Reselect photo', { exact: true })).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Save and identify 1 cards', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Batch identification', exact: true }),
  ).toBeVisible();
  expect(requests).toBe(0);
  await page.getByRole('button', { name: 'Close batch', exact: true }).click();
  await page.getByRole('button', { name: /^All cards/ }).click();
  await expect(page.locator('.collection-card')).toHaveCount(1);
  await page.getByRole('button', { name: 'Bulk add', exact: true }).click();
  await dialog.getByRole('button', { name: 'Resume AI photo matching', exact: true }).click();
  await expect(
    dialog.getByRole('heading', { name: '0 proposed pairs · 1 unmatched photo', exact: true }),
  ).toBeVisible();
  await expect(dialog.getByAltText('Unmatched photo', { exact: true })).toBeVisible();
  await expect(
    dialog.locator('figcaption').getByText('unmatched.jpg', { exact: true }),
  ).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(requests).toBe(0);
});

test('AI photo matching reviews shuffled pairs, keeps unmatched photos and opens identification after saving', async ({
  page,
}, testInfo) => {
  await page.goto('./');
  await page.getByRole('button', { name: 'Bulk add', exact: true }).click();
  const dialog = page.getByRole('dialog');
  const names = [
    'a-front.jpg',
    'b-front.jpg',
    'b-back.jpg',
    'a-back.jpg',
    'unknown1.jpg',
    'unknown2.jpg',
    'unknown3.jpg',
  ];
  const paths = names.map((name) => {
    const file = testInfo.outputPath(name);
    copyFileSync(path.resolve('tests/fixtures/card.jpg'), file);
    return file;
  });
  await dialog.getByLabel('Front and back photos').setInputFiles(paths);
  const references = await dialog
    .getByLabel('Front and back photos')
    .evaluate((input: HTMLInputElement) =>
      Array.from(input.files!).map(({ name, size, lastModified }) => ({
        name,
        size,
        lastModified,
      })),
    );
  let requests = 0;
  page.on('request', (r) => {
    if (r.url().endsWith('/identify')) requests++;
  });
  await dialog.getByRole('button', { name: 'Match and identify with AI', exact: true }).click();
  await expect(dialog.getByText('7 photos · 4 matching requests')).toBeVisible();
  await expect(
    dialog.getByRole('button', { name: 'Send 7 photos to AI', exact: true }),
  ).toBeEnabled();
  expect(requests).toBe(0);
  await dialog.getByRole('button', { name: 'Back to import', exact: true }).click();
  await page.evaluate(async (refs) => {
    const results = Object.fromEntries(
      refs.map((source) => [
        JSON.stringify([source.name, source.size, source.lastModified]),
        {
          analysis: {
            side: source.name.includes('front')
              ? 'front'
              : source.name.includes('back')
                ? 'back'
                : 'unknown',
            name: source.name.startsWith('a-')
              ? 'Player A'
              : source.name.startsWith('b-')
                ? 'Player B'
                : '',
            maker: 'Test maker',
            set: 'Test set',
            year: '2026',
            cardNumber: '',
            variant: '',
            serial: '',
            evidence: 'Printed name and maker.',
            warnings: [],
          },
        },
      ]),
    );
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open('card-cabinet');
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = database.transaction('settings', 'readwrite');
      tx.objectStore('settings').put({
        key: 'aiPhotoMatching',
        value: {
          version: 1,
          id: 'matching-ui-test',
          files: refs,
          identificationOptions: { model: 'gpt-6-luna', reasoningEffort: 'low' },
          cursor: refs.length,
          processing: null,
          status: 'complete',
          lastAttemptAt: 0,
          notBefore: 0,
          results,
          error: '',
        },
      });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    database.close();
  }, references);
  await dialog.getByRole('button', { name: 'Match and identify with AI', exact: true }).click();
  await expect(
    dialog.getByRole('heading', { name: '2 proposed pairs · 3 unmatched photos' }),
  ).toBeVisible();
  await expect(dialog.locator('figcaption').first()).toContainText('a-front.jpg');
  await expect(dialog.locator('figcaption').nth(1)).toContainText('a-back.jpg');
  await dialog.getByRole('button', { name: 'Unpair these photos', exact: true }).click();
  await expect(
    dialog.getByRole('heading', { name: '1 proposed pair · 5 unmatched photos' }),
  ).toBeVisible();
  await dialog.getByRole('button', { name: 'Back to import', exact: true }).click();
  await dialog.getByRole('button', { name: 'Resume AI photo matching', exact: true }).click();
  await expect(
    dialog.getByRole('heading', { name: '1 proposed pair · 5 unmatched photos' }),
  ).toBeVisible();
  await dialog.getByText('Review 5 unmatched photos', { exact: true }).click();
  const select = async (label: string, name: string) => {
    const value = await dialog
      .getByLabel(label, { exact: true })
      .locator('option')
      .filter({ hasText: name })
      .getAttribute('value');
    await dialog.getByLabel(label, { exact: true }).selectOption(value!);
  };
  await select('Manual front photo', 'a-front.jpg');
  await select('Manual back photo', 'a-back.jpg');
  await dialog.getByRole('button', { name: 'Pair selected photos', exact: true }).click();
  await expect(
    dialog.getByRole('heading', { name: '2 proposed pairs · 3 unmatched photos' }),
  ).toBeVisible();
  await expect(dialog.getByAltText('Selected front photo')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('ai-photo-matching.png'), fullPage: true });
  await dialog.getByRole('button', { name: 'Use 2 pairs', exact: true }).click();
  await expect(
    dialog.getByText('2 reviewed pairs. 3 unmatched photos remain in the AI matching draft.'),
  ).toBeVisible();
  await dialog.getByRole('button', { name: 'Resume AI photo matching', exact: true }).click();
  await expect(
    dialog.getByRole('heading', { name: '0 proposed pairs · 3 unmatched photos' }),
  ).toBeVisible();
  await select('Manual front photo', 'unknown1.jpg');
  await select('Manual back photo', 'unknown2.jpg');
  await dialog.getByRole('button', { name: 'Pair selected photos', exact: true }).click();
  await dialog.getByRole('button', { name: 'Use 1 pair', exact: true }).click();
  await expect(
    dialog.getByText('3 reviewed pairs. 1 unmatched photo remains in the AI matching draft.'),
  ).toBeVisible();
  await dialog.getByRole('button', { name: 'Save and identify 3 cards', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Batch identification', exact: true }),
  ).toBeVisible();
  expect(requests).toBe(0);
  await page.getByRole('button', { name: 'Close batch', exact: true }).click();
  await page.getByRole('button', { name: /^All cards/ }).click();
  await expect(page.locator('.collection-card')).toHaveCount(3);
  await page.getByRole('button', { name: 'Bulk add', exact: true }).click();
  await dialog.getByRole('button', { name: 'Resume AI photo matching', exact: true }).click();
  await expect(
    dialog.getByRole('heading', { name: '0 proposed pairs · 1 unmatched photo' }),
  ).toBeVisible();
  await expect(
    dialog.locator('figcaption').getByText('unknown3.jpg', { exact: true }),
  ).toBeVisible();
});

test('failed photo previews stop showing a loading state and keep the other preview', async ({
  page,
}) => {
  await page.goto('./');
  await page.getByRole('button', { name: 'Bulk add', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Front and back photos').setInputFiles([
    { name: 'broken.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('broken image') },
    {
      name: 'valid.jpg',
      mimeType: 'image/jpeg',
      buffer: (await import('node:fs')).readFileSync(path.resolve('tests/fixtures/card.jpg')),
    },
  ]);
  await dialog.getByRole('button', { name: 'Review import', exact: true }).click();
  await expect(dialog.getByText('Preview unavailable', { exact: true })).toBeVisible();
  await expect(dialog.getByAltText('Selected back photo')).toBeVisible();
  await expect(dialog.getByText('Loading preview…', { exact: true })).toHaveCount(0);
});
