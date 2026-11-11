import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { newCard, type Card, type Draft, type LocalCard, type Operation } from '../../src/model';

const hashes = {
  active: 'a'.repeat(64),
  archived: 'b'.repeat(64),
  visible: 'c'.repeat(64),
  hidden: 'd'.repeat(64),
};
const photoBytes = [...readFileSync(path.resolve('tests/fixtures/card.jpg'))];

function fixtureCards() {
  function card(name: string, status: Card['status'], front: string, back: string | null) {
    const value = newCard();
    value.fields.name = name;
    value.fields.set = 'Bin test collection';
    value.fields.notes = 'Private details for ' + name;
    value.status = status;
    value.photos = { front, back };
    return value;
  }
  return {
    active: card('Active keeper', 'active', hashes.active, null),
    archived: card('Archived keeper', 'archived', hashes.archived, null),
    visible: card('Deleted visible', 'deleted', hashes.active, hashes.visible),
    hidden: card('Deleted hidden', 'deleted', hashes.archived, hashes.hidden),
  };
}

async function writeCards(page: Page, cards: Card[], withPhotos = false) {
  await page.evaluate(
    async ({ cards, photoBytes, photoHashes }) => {
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('card-cabinet');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      try {
        await new Promise<void>((resolve, reject) => {
          const tx = database.transaction(['cards', 'photos', 'queue'], 'readwrite');
          for (const card of cards) {
            tx.objectStore('cards').put({ ...card, baseRev: 1, localVersion: 1, syncedVersion: 0 });
            tx.objectStore('queue').put({
              id: card.id,
              mutationId: crypto.randomUUID(),
              baseRev: 1,
              version: 1,
              card,
            });
          }
          for (const hash of photoHashes) {
            tx.objectStore('photos').put({
              hash,
              bytes: new Uint8Array(photoBytes).buffer,
              type: 'image/jpeg',
              size: photoBytes.length,
            });
          }
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
          tx.onabort = () => reject(tx.error);
        });
      } finally {
        database.close();
      }
    },
    { cards, photoBytes, photoHashes: withPhotos ? Object.values(hashes) : [] },
  );
}

async function savedState(page: Page) {
  return page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('card-cabinet');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const tx = database.transaction(['cards', 'photos', 'queue', 'settings'], 'readonly');
      const read = <T>(request: IDBRequest<T>) =>
        new Promise<T>((resolve, reject) => {
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
      const [cards, photoHashes, queue, draft] = await Promise.all([
        read(tx.objectStore('cards').getAll()) as Promise<LocalCard[]>,
        read(tx.objectStore('photos').getAllKeys()),
        read(tx.objectStore('queue').getAll()) as Promise<Operation[]>,
        read(tx.objectStore('settings').get('draft')) as Promise<{ value: Draft } | undefined>,
      ]);
      return {
        cards,
        photoHashes: photoHashes.map(String).sort(),
        queue,
        draft: draft?.value ?? null,
      };
    } finally {
      database.close();
    }
  });
}

async function openSeededBin(page: Page) {
  await page.goto('./');
  await expect(page.getByRole('heading', { name: 'Your collection', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Add test cards', exact: true })).toBeEnabled();
  const cards = fixtureCards();
  await writeCards(page, Object.values(cards), true);
  await page.reload();
  await page.getByRole('button', { name: /^Recently deleted/ }).click();
  await expect(page.getByRole('heading', { name: 'Recently deleted', exact: true })).toBeVisible();
  await expect(page.locator('.collection-card')).toHaveCount(2);
  await expect(page.getByRole('button', { name: /^Recently deleted/ })).toHaveText(
    /Recently deleted\s*2/,
  );
  return cards;
}

function expectPurged(state: Awaited<ReturnType<typeof savedState>>, id: string) {
  const card = state.cards.find((value) => value.id === id);
  expect(card?.status).toBe('purged');
  expect(card?.photos).toEqual({ front: null, back: null });
  expect(Object.values(card!.fields).every((value) => value === '')).toBe(true);
  const operation = state.queue.find((value) => value.id === id);
  expect(operation?.card.status).toBe('purged');
  expect(operation?.card.photos).toEqual({ front: null, back: null });
  expect(Object.values(operation!.card.fields).every((value) => value === '')).toBe(true);
}

async function expectFitsViewport(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  const dialog = page.getByRole('dialog');
  if (await dialog.count()) {
    const bounds = await dialog.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(await page.evaluate(() => innerWidth));
  }
}

test('Empty bin confirms all deleted cards despite a filter and keeps shared photos', async ({
  page,
}, testInfo) => {
  const cards = await openSeededBin(page);
  const before = await savedState(page);
  await page.getByLabel('Search collection').fill('Deleted visible');
  await expect(page.locator('.collection-card')).toHaveCount(1);
  await page.getByRole('button', { name: 'Empty bin', exact: true }).click();
  const confirmation = page.getByRole('dialog', { name: 'Empty bin?', exact: true });
  await expect(confirmation).toBeVisible();
  await expect(confirmation.getByText(/Permanently delete 2 cards and their photos/)).toBeVisible();
  await expect(confirmation.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
  await expectFitsViewport(page);
  await page.screenshot({
    path: testInfo.outputPath('empty-bin-confirmation.png'),
    fullPage: true,
  });
  await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(confirmation).toHaveCount(0);
  expect(await savedState(page)).toEqual(before);

  await page.getByRole('button', { name: 'Empty bin', exact: true }).click();
  await confirmation.getByRole('button', { name: 'Empty bin', exact: true }).click();
  await expect(confirmation).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Bin is empty', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Empty bin', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: /^Recently deleted/ })).toHaveText(
    /Recently deleted\s*0/,
  );
  const after = await savedState(page);
  expectPurged(after, cards.visible.id);
  expectPurged(after, cards.hidden.id);
  for (const keeper of [cards.active, cards.archived]) {
    expect(after.cards.find((value) => value.id === keeper.id)).toEqual(
      before.cards.find((value) => value.id === keeper.id),
    );
    expect(after.queue.find((value) => value.id === keeper.id)).toEqual(
      before.queue.find((value) => value.id === keeper.id),
    );
  }
  expect(after.photoHashes).toEqual([hashes.active, hashes.archived]);
  await expectFitsViewport(page);
  await page.screenshot({ path: testInfo.outputPath('empty-bin.png'), fullPage: true });

  await page.reload();
  await page.getByRole('button', { name: /^All cards/ }).click();
  await expect(page.locator('.collection-card')).toHaveCount(1);
  await page.getByRole('button', { name: 'Open Active keeper', exact: true }).click();
  await expect(
    page.getByRole('img', { name: 'front of Active keeper', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await page.getByRole('button', { name: /^Archived/ }).click();
  await expect(page.locator('.collection-card')).toHaveCount(1);
  await page.getByRole('button', { name: 'Open Archived keeper', exact: true }).click();
  await expect(
    page.getByRole('img', { name: 'front of Archived keeper', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await page.getByRole('button', { name: /^Recently deleted/ }).click();
  await expect(page.getByRole('heading', { name: 'Bin is empty', exact: true })).toBeVisible();
  await expect(page.locator('.collection-card')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Empty bin', exact: true })).toBeDisabled();
  expect(await savedState(page)).toEqual(after);
});

test('permanent deletion cancels safely and removes only the selected deleted card', async ({
  page,
}, testInfo) => {
  const cards = await openSeededBin(page);
  const before = await savedState(page);
  await page.getByRole('button', { name: 'Open Deleted visible', exact: true }).click();
  await page.getByRole('button', { name: 'Delete permanently', exact: true }).click();
  const confirmation = page.getByRole('dialog', { name: 'Delete permanently?', exact: true });
  await expect(confirmation.getByText(/Permanently delete 1 card and their photos/)).toBeVisible();
  await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(await savedState(page)).toEqual(before);

  await page.getByRole('button', { name: 'Open Deleted visible', exact: true }).click();
  await page.getByRole('button', { name: 'Delete permanently', exact: true }).click();
  await expectFitsViewport(page);
  await page.screenshot({
    path: testInfo.outputPath('permanent-delete-confirmation.png'),
    fullPage: true,
  });
  await confirmation.getByRole('button', { name: 'Delete permanently', exact: true }).click();
  await expect(confirmation).toHaveCount(0);
  await expect(page.locator('.collection-card')).toHaveCount(1);
  await expect(
    page.getByRole('button', { name: 'Open Deleted hidden', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: /^Recently deleted/ })).toHaveText(
    /Recently deleted\s*1/,
  );
  const after = await savedState(page);
  expectPurged(after, cards.visible.id);
  expect(after.cards.find((value) => value.id === cards.hidden.id)).toEqual(
    before.cards.find((value) => value.id === cards.hidden.id),
  );
  expect(after.photoHashes).toEqual([hashes.active, hashes.archived, hashes.hidden]);

  await page.reload();
  await page.getByRole('button', { name: /^Recently deleted/ }).click();
  await expect(page.locator('.collection-card')).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Open Deleted visible', exact: true })).toHaveCount(
    0,
  );
  await page.getByRole('button', { name: 'Open Deleted hidden', exact: true }).click();
  await expect(
    page.getByRole('img', { name: 'back of Deleted hidden', exact: true }),
  ).toBeVisible();
  expect(await savedState(page)).toEqual(after);
});

test('Empty bin uses its confirmed snapshot and preserves cards restored before deletion', async ({
  page,
}) => {
  const cards = await openSeededBin(page);
  await page.getByRole('button', { name: 'Empty bin', exact: true }).click();
  const confirmation = page.getByRole('dialog', { name: 'Empty bin?', exact: true });
  await expect(confirmation).toBeVisible();
  const restored = { ...cards.visible, status: 'active' as const };
  const later = newCard();
  later.status = 'deleted';
  later.fields.name = 'Deleted after confirmation';
  await writeCards(page, [restored, later]);
  await confirmation.getByRole('button', { name: 'Empty bin', exact: true }).click();
  await expect(confirmation).toHaveCount(0);
  const after = await savedState(page);
  expectPurged(after, cards.hidden.id);
  expect(after.cards.find((value) => value.id === restored.id)).toMatchObject(restored);
  expect(after.cards.find((value) => value.id === later.id)).toMatchObject(later);
  expect(after.photoHashes).toEqual([hashes.active, hashes.archived, hashes.visible]);
  await page.reload();
  await page.getByRole('button', { name: /^Recently deleted/ }).click();
  await expect(page.locator('.collection-card')).toHaveCount(1);
  await expect(
    page.getByRole('button', { name: 'Open Deleted after confirmation', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: /^All cards/ }).click();
  await expect(page.locator('.collection-card')).toHaveCount(2);
  await expect(
    page.getByRole('button', { name: 'Open Deleted visible', exact: true }),
  ).toBeVisible();
});

test('permanent deletion in another tab closes the editor and removes its unsaved draft', async ({
  page,
  context,
}) => {
  const cards = await openSeededBin(page);
  await page.getByRole('button', { name: /^All cards/ }).click();
  await page.getByRole('button', { name: 'Open Active keeper', exact: true }).click();
  await page.getByRole('button', { name: 'Edit card', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'Edit card', exact: true });
  await editor.getByLabel('Player or character', { exact: true }).fill('Unsaved edit in other tab');
  await expect(editor.getByText('Draft saved on this device', { exact: true })).toBeVisible();
  expect((await savedState(page)).draft?.card.fields.name).toBe('Unsaved edit in other tab');

  const otherTab = await context.newPage();
  try {
    await otherTab.goto('./');
    await otherTab.getByRole('button', { name: /^All cards/ }).click();
    await otherTab.getByRole('button', { name: 'Open Active keeper', exact: true }).click();
    await otherTab.getByRole('button', { name: 'Delete', exact: true }).click();
    await otherTab.getByRole('button', { name: /^Recently deleted/ }).click();
    await otherTab.getByRole('button', { name: 'Open Active keeper', exact: true }).click();
    await otherTab.getByRole('button', { name: 'Delete permanently', exact: true }).click();
    const confirmation = otherTab.getByRole('dialog', { name: 'Delete permanently?', exact: true });
    await confirmation.getByRole('button', { name: 'Delete permanently', exact: true }).click();
    await expect(confirmation).toHaveCount(0);

    await page.bringToFront();
    await expect(editor).toHaveCount(0);
    await expect(
      page.getByText('This card was permanently deleted on another tab or device.', {
        exact: true,
      }),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Resume draft', exact: true })).toHaveCount(0);
    const after = await savedState(page);
    expectPurged(after, cards.active.id);
    expect(after.draft).toBeNull();
    expect(after.photoHashes).toEqual(Object.values(hashes));

    await page.reload();
    await page.getByRole('button', { name: /^All cards/ }).click();
    await expect(page.locator('.collection-card')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Resume draft', exact: true })).toHaveCount(0);
    expect((await savedState(page)).draft).toBeNull();
  } finally {
    await otherTab.close();
  }
});
