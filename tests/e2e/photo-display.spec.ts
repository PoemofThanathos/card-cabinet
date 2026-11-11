import { test, expect, type Page } from '@playwright/test';
import { newCard } from '../../src/model';

async function seedReceivedPhoto(page: Page) {
  const card = newCard();
  card.fields.name = 'Photo crop test';
  card.fields.set = '2026 Topps Series 1';
  card.fields.year = '2026';
  card.fields.rarity = 'Base';
  return page.evaluate(async (card) => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1000;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#614631';
    ctx.fillRect(0, 0, 1000, 1000);
    ctx.fillStyle = '#f8f8f3';
    ctx.fillRect(220, 100, 550, 770);
    ctx.fillStyle = '#203f34';
    ctx.fillRect(250, 130, 490, 620);
    ctx.fillStyle = '#fff';
    ctx.font = '36px sans-serif';
    ctx.fillText('CARD PHOTO', 290, 220);
    ctx.fillStyle = '#203f34';
    ctx.fillText('TEST 001', 290, 815);
    const blob = await new Promise<Blob>((resolve) =>
      canvas.toBlob((b) => resolve(b!), 'image/jpeg', 0.95),
    );
    const bytes = await blob.arrayBuffer();
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
      .map((v) => v.toString(16).padStart(2, '0'))
      .join('');
    card.photos.front = hash;
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('card-cabinet');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = database.transaction(['cards', 'photos'], 'readwrite');
      tx.objectStore('photos').put({ hash, bytes, type: 'image/jpeg', size: blob.size });
      tx.objectStore('cards').put({ ...card, baseRev: 1, localVersion: 1, syncedVersion: 1 });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    database.close();
    return { hash, id: card.id };
  }, card);
}

async function openPhoto(page: Page) {
  await page.getByRole('button', { name: /^All cards/ }).click();
  await page.getByRole('button', { name: 'Open Photo crop test', exact: true }).click();
  return page.getByRole('img', { name: 'front of Photo crop test', exact: true });
}

test('received photos crop locally; adjustments survive reload without changing the original', async ({
  page,
}, testInfo) => {
  const posts: string[] = [];
  page.on('request', (req) => {
    if (req.method() === 'POST') posts.push(req.url());
  });
  await page.goto('./');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Add test cards', exact: true })).toBeEnabled();
  const original = await seedReceivedPhoto(page);
  await page.reload();
  let photo = await openPhoto(page);
  await expect(photo).toHaveAttribute('data-preview-mode', 'auto');
  await expect
    .poll(() => photo.evaluate((img: HTMLImageElement) => img.naturalWidth / img.naturalHeight))
    .toBeLessThan(0.85);
  await page.screenshot({ path: testInfo.outputPath('automatic-card-crop.png'), fullPage: true });

  await page.getByRole('button', { name: 'Original', exact: true }).click();
  await expect(photo).toHaveAttribute('data-preview-mode', 'original');
  await expect
    .poll(() => photo.evaluate((img: HTMLImageElement) => [img.naturalWidth, img.naturalHeight]))
    .toEqual([1000, 1000]);
  await page.reload();
  photo = await openPhoto(page);
  await expect(photo).toHaveAttribute('data-preview-mode', 'original');
  await page.getByRole('button', { name: 'Auto crop', exact: true }).click();
  await expect(photo).toHaveAttribute('data-preview-mode', 'auto');
  await expect
    .poll(() => photo.evaluate((img: HTMLImageElement) => img.naturalWidth / img.naturalHeight))
    .toBeLessThan(0.85);
  await page.getByRole('button', { name: 'Adjust crop', exact: true }).click();
  const adjust = page.getByRole('dialog', { name: 'Adjust card photo', exact: true });
  const sourcePreview = adjust.getByRole('img', { name: 'Original photo for cropping' });
  await expect(sourcePreview).toBeVisible();
  const sourceBounds = await sourcePreview.boundingBox();
  expect(Math.abs(sourceBounds!.width - sourceBounds!.height)).toBeLessThan(1);
  await adjust.getByLabel('left', { exact: true }).fill('20');
  await adjust.getByLabel('top', { exact: true }).fill('10');
  await adjust.getByLabel('right', { exact: true }).fill('80');
  await adjust.getByLabel('bottom', { exact: true }).fill('90');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const bounds = await adjust.boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(await page.evaluate(() => innerWidth));
  await page.screenshot({ path: testInfo.outputPath('adjust-card-crop.png'), fullPage: true });
  await adjust.getByRole('button', { name: 'Save crop', exact: true }).click();
  await expect(adjust).toHaveCount(0);
  await expect(photo).toHaveAttribute('data-preview-mode', 'manual');
  await expect
    .poll(() => photo.evaluate((img: HTMLImageElement) => [img.naturalWidth, img.naturalHeight]))
    .toEqual([600, 800]);
  await page.getByRole('button', { name: 'Rotate front of Photo crop test', exact: true }).click();
  await expect
    .poll(() => photo.evaluate((img: HTMLImageElement) => [img.naturalWidth, img.naturalHeight]))
    .toEqual([800, 600]);
  await page.reload();
  photo = await openPhoto(page);
  await expect
    .poll(() => photo.evaluate((img: HTMLImageElement) => [img.naturalWidth, img.naturalHeight]))
    .toEqual([800, 600]);
  const saved = await page.evaluate(async ({ hash, id }) => {
    const database = await new Promise<IDBDatabase>((resolve) => {
      const req = indexedDB.open('card-cabinet');
      req.onsuccess = () => resolve(req.result);
    });
    const tx = database.transaction(['cards', 'photos', 'photoDisplays', 'queue']);
    const read = <T>(req: IDBRequest<T>) =>
      new Promise<T>((resolve) => {
        req.onsuccess = () => resolve(req.result);
      });
    const [photo, display, card, queue] = await Promise.all([
      read(tx.objectStore('photos').get(hash)),
      read(tx.objectStore('photoDisplays').get(hash)),
      read(tx.objectStore('cards').get(id)),
      read(tx.objectStore('queue').count()),
    ]);
    database.close();
    const actualHash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', photo.bytes))]
      .map((v) => v.toString(16).padStart(2, '0'))
      .join('');
    return {
      hash: actualHash,
      mode: display.mode,
      rotation: display.rotation,
      crop: display.crop,
      cardHash: card.photos.front,
      queue,
    };
  }, original);
  expect(saved).toEqual({
    hash: original.hash,
    cardHash: original.hash,
    mode: 'manual',
    rotation: 90,
    crop: { left: 10, top: 20, right: 90, bottom: 80 },
    queue: 0,
  });
  await page.evaluate(async (hash) => {
    const database = await new Promise<IDBDatabase>((resolve) => {
      const req = indexedDB.open('card-cabinet');
      req.onsuccess = () => resolve(req.result);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = database.transaction('photoDisplays', 'readwrite');
      const store = tx.objectStore('photoDisplays');
      const req = store.get(hash);
      req.onsuccess = () => store.put({ ...req.result, bytes: new Uint8Array([1, 2, 3]).buffer });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    database.close();
  }, original.hash);
  await page.reload();
  photo = await openPhoto(page);
  await expect(photo).toHaveAttribute('data-preview-mode', 'manual');
  await expect
    .poll(() => photo.evaluate((img: HTMLImageElement) => [img.naturalWidth, img.naturalHeight]))
    .toEqual([800, 600]);
  expect(posts).toEqual([]);
});
