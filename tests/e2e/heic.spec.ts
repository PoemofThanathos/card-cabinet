import { expect, test } from '@playwright/test';
import path from 'node:path';

// libheif's synthetic 451 x 461 rainbow, from its official tests/data directory.
const heicFixture = path.resolve('tests/fixtures/rainbow-451x461.heic');

test('HEIC imports locally, rotates, crops and saves a JPEG without EXIF', async ({ page }) => {
  const uploads: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST') uploads.push(request.url());
  });
  await page.goto('./');
  await page.getByRole('button', { name: 'Add your first card', exact: true }).click();
  await page.getByLabel('Player or character', { exact: true }).fill('HEIC photo test');
  await page
    .locator('.photo-picker')
    .first()
    .locator('input[type=file]:not([capture])')
    .setInputFiles(heicFixture);
  const preview = page.getByRole('img', { name: 'Photo before crop', exact: true });
  await expect(preview).toBeVisible();
  await expect
    .poll(() => preview.evaluate((image: HTMLImageElement) => image.naturalWidth))
    .toBe(451);
  await page.getByRole('button', { name: 'Rotate 90°' }).click();
  await expect
    .poll(() => preview.evaluate((image: HTMLImageElement) => image.naturalWidth))
    .toBe(461);
  await page.getByLabel('left', { exact: true }).fill('5');
  await page.getByRole('button', { name: 'Use photo', exact: true }).click();
  const saved = page.getByRole('img', { name: 'front of card', exact: true });
  await expect(saved).toBeVisible();
  const result = await saved.evaluate(async (image: HTMLImageElement) => {
    const blob = await (await fetch(image.src)).blob();
    const bytes = new Uint8Array(await blob.arrayBuffer());
    return {
      type: blob.type,
      width: image.naturalWidth,
      height: image.naturalHeight,
      signature: Array.from(bytes.slice(0, 3)),
      exif: new TextDecoder('latin1').decode(bytes).includes('Exif\0\0'),
    };
  });
  expect(result).toEqual({
    type: 'image/jpeg',
    width: 438,
    height: 451,
    signature: [255, 216, 255],
    exif: false,
  });
  expect(uploads).toEqual([]);
  await page.getByRole('button', { name: 'Save card', exact: true }).click();
  await page.getByRole('button', { name: /^All cards/ }).click();
  await expect(
    page.getByRole('button', { name: 'Open HEIC photo test', exact: true }),
  ).toBeVisible();
});

test('a corrupt HEIC explains recovery and another photo can still be imported', async ({
  page,
}) => {
  await page.goto('./');
  await page.getByRole('button', { name: 'Add your first card', exact: true }).click();
  const input = page.locator('.photo-picker').first().locator('input[type=file]:not([capture])');
  await input.setInputFiles({
    name: 'broken.heic',
    mimeType: 'image/heic',
    buffer: Buffer.from('broken file'),
  });
  const dialog = page.getByRole('dialog').last();
  await expect(dialog.getByRole('alert')).toContainText('Export it as JPEG from Photos');
  await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await input.setInputFiles(heicFixture);
  await expect(page.getByRole('img', { name: 'Photo before crop', exact: true })).toBeVisible();
});

test('the cached decoder imports its first HEIC while offline', async ({
  page,
  context,
  browserName,
}) => {
  test.skip(
    browserName !== 'chromium',
    'The Windows WebKit runner does not provide service workers.',
  );
  await page.goto('./');
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller)
      await new Promise<void>((resolve) =>
        navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), {
          once: true,
        }),
      );
  });
  await context.setOffline(true);
  await page.reload();
  await page.getByRole('button', { name: 'Add your first card', exact: true }).click();
  await page
    .locator('.photo-picker')
    .first()
    .locator('input[type=file]:not([capture])')
    .setInputFiles(heicFixture);
  await expect(page.getByRole('img', { name: 'Photo before crop', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Use photo', exact: true }).click();
  await expect(page.getByRole('img', { name: 'front of card', exact: true })).toBeVisible();
});
