import { test, expect } from '@playwright/test';
import { newCard } from '../../src/model';

test('individual identification confirms the selected model and reasoning before sending', async ({
  page,
}) => {
  await page.goto('./');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Add test cards', exact: true }).click();
  await expect(
    page.getByText('12 test cards added. Their artwork and card details are fictional.'),
  ).toBeVisible();
  await page.getByLabel('Identification model', { exact: true }).selectOption('gpt-6.1-sol');
  await expect(page.getByLabel('Reasoning effort', { exact: true })).toBeEnabled();
  await page.getByLabel('Reasoning effort', { exact: true }).selectOption('medium');
  await expect(page.getByLabel('Identification model', { exact: true })).toBeEnabled();
  await page.getByRole('button', { name: /^All cards/ }).click();
  await page.locator('.collection-card .card-open').first().click();
  await page.getByRole('button', { name: 'Edit card', exact: true }).click();
  const sent: string[] = [];
  page.on('request', (request) => {
    if (request.url().endsWith('/identify')) sent.push(request.url());
  });
  const confirmation = page.waitForEvent('dialog');
  const click = page.getByRole('button', { name: 'Identify', exact: true }).click();
  const dialog = await confirmation;
  expect(dialog.type()).toBe('confirm');
  expect(dialog.message()).toContain('GPT-6.1 Sol · Medium reasoning');
  await dialog.dismiss();
  await click;
  await expect(page.getByRole('button', { name: 'Identify', exact: true })).toBeEnabled();
  expect(sent).toEqual([]);
});

test('more than three selected cards reach the batch confirmation', async ({ page }) => {
  await page.goto('./');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Add test cards', exact: true }).click();
  await expect(
    page.getByText('12 test cards added. Their artwork and card details are fictional.'),
  ).toBeVisible();
  await page.getByRole('button', { name: /^All cards/ }).click();
  const selected = page.getByRole('checkbox', { name: /^Select .* for identification$/ });
  await expect(selected).toHaveCount(12);
  for (const checkbox of await selected.all()) await checkbox.check();
  await page.getByRole('button', { name: 'Identify selected · 12' }).click();
  await expect(
    page.getByRole('heading', { name: 'Batch identification', exact: true }),
  ).toBeVisible();
  await expect(page.getByText(/GPT-6 Luna · Low reasoning/)).toBeVisible();
  await page.getByRole('button', { name: 'Start identification of 12 cards' }).click();
  await expect(page.getByText('Enable identification in Settings first.')).toBeVisible();
});

test('saved batch review survives closing and discards only on explicit action', async ({
  page,
}, testInfo) => {
  await page.goto('./');
  await expect(page.getByRole('heading', { name: 'Your collection', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Add test cards', exact: true })).toBeEnabled();
  const card = newCard();
  card.fields.name = 'Batch test card';
  const batchId = 'test-batch';
  const reviewKey = 'aiBatchReview:' + batchId + ':' + card.id;
  await page.evaluate(
    async ({ card, batchId, reviewKey }) => {
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('card-cabinet');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      await new Promise<void>((resolve, reject) => {
        const tx = database.transaction(['cards', 'settings'], 'readwrite');
        tx.objectStore('cards').put({ ...card, baseRev: 0, localVersion: 1, syncedVersion: 0 });
        tx.objectStore('settings').put({
          key: 'aiOptions',
          value: { model: 'gpt-6-astra', reasoningEffort: 'high' },
        });
        tx.objectStore('settings').put({
          key: 'aiBatch',
          value: {
            version: 1,
            id: batchId,
            cardIds: [card.id],
            position: 1,
            processing: null,
            status: 'complete',
            lastStart: 0,
            failures: [],
            error: '',
          },
        });
        tx.objectStore('settings').put({
          key: reviewKey,
          value: {
            batchId,
            card,
            result: {
              suggestions: [
                {
                  field: 'name',
                  value: 'Suggested player',
                  source: 'visible_text',
                  evidence: 'Printed name',
                  uncertain: false,
                },
              ],
              warnings: [],
            },
          },
        });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      database.close();
    },
    { card, batchId, reviewKey },
  );
  await page.reload();
  await page.getByRole('button', { name: 'Open identification batch', exact: true }).click();
  await expect(page.getByText('GPT-6 Luna · Low reasoning', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Review Batch test card', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Review identification', exact: true }),
  ).toBeVisible();
  await expect(
    page.locator('dialog').last().getByText('GPT-6 Luna · Low reasoning', { exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('batch-review.png'), fullPage: true });
  await page.getByRole('button', { name: 'Close review', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Suggestions to review · 1' })).toBeVisible();
  await page.getByRole('button', { name: 'Review Batch test card', exact: true }).click();
  await page
    .locator('.modal-heading')
    .filter({ has: page.getByRole('heading', { name: 'Review identification', exact: true }) })
    .getByRole('button', { name: 'Close dialog', exact: true })
    .click();
  await expect(page.getByRole('heading', { name: 'Suggestions to review · 1' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page
    .getByRole('button', { name: 'Discard suggestions for Batch test card', exact: true })
    .click();
  await expect(page.getByRole('heading', { name: /Suggestions to review/ })).toHaveCount(0);
  await page.getByRole('button', { name: 'Close batch', exact: true }).click();
  await page.getByRole('button', { name: /^All cards/ }).click();
  await expect(
    page.getByRole('button', { name: 'Open Batch test card', exact: true }),
  ).toBeVisible();
});
