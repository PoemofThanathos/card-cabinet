import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { zipSync, strToU8 } from 'fflate';
import { newCard } from '../../src/model';

test('speed choice persists between local import and AI matching', async ({ page }, testInfo) => {
  await page.goto('./');
  await page.getByRole('button', { name: 'Bulk add', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Entry method').selectOption('manual');
  await dialog.getByLabel('Cards, one per line').fill('Speed test player | 1');
  await dialog.getByRole('button', { name: 'Review import', exact: true }).click();
  const speed = dialog.getByLabel('Processing speed', { exact: true });
  await expect(speed).toHaveValue('normal');
  await speed.selectOption('ultra');
  await expect(speed).toHaveValue('ultra');
  await page.screenshot({ path: testInfo.outputPath('speed-control.png'), fullPage: true });
  await dialog.getByRole('button', { name: 'Save 1 cards', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText('1 saved');
  await dialog.getByRole('button', { name: 'Finish import', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await page.reload();
  await page.getByRole('button', { name: 'Bulk add', exact: true }).click();
  await dialog.getByLabel('Front and back photos').setInputFiles([
    { name: 'front.jpg', mimeType: 'image/jpeg', buffer: readFileSync('tests/fixtures/card.jpg') },
    { name: 'back.jpg', mimeType: 'image/jpeg', buffer: readFileSync('tests/fixtures/card.jpg') },
  ]);
  await dialog.getByRole('button', { name: 'Match and identify with AI', exact: true }).click();
  await expect(speed).toHaveValue('ultra');
  await speed.selectOption('fast');
  await expect(speed).toHaveValue('fast');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('imports a review package and opens its photos and unapproved suggestions', async ({
  page,
}, testInfo) => {
  const jpeg = readFileSync('tests/fixtures/card.jpg');
  const hash = createHash('sha256').update(jpeg).digest('hex');
  const card = newCard();
  card.photos = { front: hash, back: hash };
  const manifest = {
    format: 'card-cabinet',
    version: 1,
    exportedAt: new Date().toISOString(),
    cards: [card],
    photos: [{ hash, size: jpeg.length, type: 'image/jpeg' }],
    reviews: [
      {
        cardId: card.id,
        identificationOptions: { model: 'gpt-6-luna', reasoningEffort: 'high' },
        result: {
          suggestions: [
            {
              field: 'name',
              value: 'Luna suggested player',
              source: 'visible_text',
              evidence: 'Printed on card back',
              uncertain: false,
            },
          ],
          warnings: ['Luna subagent prompt test. Review the photos.'],
        },
      },
    ],
  };
  const buffer = Buffer.from(
    zipSync({
      'manifest.json': strToU8(JSON.stringify(manifest)),
      ['photos/' + hash + '.jpg']: jpeg,
    }),
  );
  await page.goto('./');
  await page.getByRole('button', { name: 'Backups & transfer', exact: true }).click();
  await page
    .locator('input[type=file]')
    .setInputFiles({ name: 'review.cardcabinet.zip', mimeType: 'application/zip', buffer });
  await expect(page.getByText('1 cards · 1 verified photos · 1 new cards')).toBeVisible();
  await page.getByRole('button', { name: 'Import reviewed package', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: /^All cards/ }).click();
  await expect(page.getByText('1 identification results to review.')).toBeVisible();
  await page.getByRole('button', { name: 'Open identification batch', exact: true }).click();
  await page.getByRole('button', { name: 'Review Luna suggested player', exact: true }).click();
  await expect(page.getByAltText('Front of card being reviewed')).toBeVisible();
  await expect(page.getByAltText('Back of card being reviewed')).toBeVisible();
  await expect(page.getByText('Luna suggested player', { exact: true })).toBeVisible();
  await expect(page.locator('.suggestion input[type=checkbox]')).not.toBeChecked();
  await page.screenshot({ path: testInfo.outputPath('imported-review.png'), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
