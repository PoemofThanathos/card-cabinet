import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

test('manual bulk entry and base-set exceptions preserve separate physical variants', async ({
  page,
}, testInfo) => {
  await page.goto('./');
  await page.getByRole('button', { name: 'Bulk add', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Entry method').selectOption('manual');
  await dialog.getByLabel('Category', { exact: true }).fill('MLB');
  await dialog.getByLabel('Maker', { exact: true }).fill('Topps');
  await dialog.getByLabel('Set', { exact: true }).fill('Bulk test series');
  await dialog.getByLabel('Year', { exact: true }).fill('2026');
  await dialog
    .getByLabel('Cards, one per line')
    .fill('Player One | 1 | Team | Base\nPlayer Two | 3 | Team | Gold');
  await dialog.getByRole('button', { name: 'Review import', exact: true }).click();
  await expect(dialog.getByText('2 cards. No photos or AI are needed.')).toBeVisible();
  await dialog.getByRole('button', { name: 'Save 2 cards', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText('2 saved');
  await dialog.getByRole('button', { name: 'Finish import', exact: true }).click();
  await page.getByRole('button', { name: 'Bulk add', exact: true }).click();
  await dialog.getByLabel('Entry method').selectOption('base');
  await dialog.getByLabel('Category', { exact: true }).fill('MLB');
  await dialog.getByLabel('Maker', { exact: true }).fill('Topps');
  await dialog.getByLabel('Set', { exact: true }).fill('Bulk test series');
  await dialog.getByLabel('Year', { exact: true }).fill('2026');
  await dialog.getByLabel('Base checklist numbers').fill('1-3');
  await dialog.getByRole('combobox', { name: 'Ownership', exact: true }).selectOption('missing');
  await dialog.getByRole('textbox', { name: 'Missing numbers', exact: true }).fill('2');
  await dialog.getByRole('button', { name: 'Review import', exact: true }).click();
  await expect(dialog.getByText(/2 owned base cards.*1 missing card: 2/)).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('base-set-review.png'), fullPage: true });
  await dialog.getByRole('button', { name: 'Save 2 cards', exact: true }).click();
  await expect(dialog.getByRole('status')).toHaveText('1 saved · 1 already owned · 0 left to save');
  await dialog.getByRole('button', { name: 'Finish import', exact: true }).click();
  await page.getByRole('button', { name: /^All cards/ }).click();
  await expect(page.locator('.collection-card')).toHaveCount(3);
  await page.reload();
  await page.getByRole('button', { name: /^All cards/ }).click();
  await expect(page.locator('.collection-card')).toHaveCount(3);
});

test('photo import accepts over 100 photos and offers reviewed pairing without sending AI calls', async ({
  page,
}, testInfo) => {
  let identificationCalls = 0;
  page.on('request', (request) => {
    if (request.url().endsWith('/identify')) identificationCalls++;
  });
  await page.goto('./');
  await page.getByRole('button', { name: 'Bulk add', exact: true }).click();
  const dialog = page.getByRole('dialog');
  const fixture = readFileSync(path.resolve('tests/fixtures/card.jpg'));
  await dialog.getByLabel('Front and back photos').setInputFiles(
    Array.from({ length: 120 }, (_, i) => ({
      name: `photo${i + 1}.jpg`,
      mimeType: 'image/jpeg',
      buffer: fixture,
    })),
  );
  await expect(dialog.getByText('120 photos selected')).toBeVisible();
  await dialog.getByRole('button', { name: 'Review import', exact: true }).click();
  await expect(
    dialog.getByText('120 photos, 60 cards. Check each front/back pair before saving.'),
  ).toBeVisible();
  await expect(dialog.getByAltText('Selected front photo')).toBeVisible();
  await expect(dialog.getByText('photo1.jpg', { exact: true })).toBeVisible();
  await expect(dialog.getByText('photo2.jpg', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Swap front and back' }).click();
  await expect(dialog.locator('figcaption').first()).toContainText('photo2.jpg');
  await expect(dialog.getByAltText('Selected front photo')).toBeVisible();
  await expect(dialog.getByAltText('Selected back photo')).toBeVisible();
  const oldFront = await dialog.getByAltText('Selected front photo').getAttribute('src');
  const oldBack = await dialog.getByAltText('Selected back photo').getAttribute('src');
  await dialog.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(dialog.getByText('photo3.jpg', { exact: true })).toBeVisible();
  await expect(dialog.getByAltText('Selected front photo')).toBeVisible();
  await expect(dialog.getByAltText('Selected back photo')).toBeVisible();
  await expect(dialog.getByAltText('Selected front photo')).not.toHaveAttribute('src', oldFront!);
  await expect(dialog.getByAltText('Selected back photo')).not.toHaveAttribute('src', oldBack!);
  await expect(dialog.getByLabel('Reselect source photos to resume')).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('bulk-photo-pairing.png'), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  expect(identificationCalls).toBe(0);
});
