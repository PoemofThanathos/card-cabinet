import { test, expect } from '@playwright/test';
import path from 'node:path';

test('set grid, all-card list and player grid with persistent test cards', async ({
  page,
}, testInfo) => {
  await page.goto('./');
  await expect(page.getByRole('button', { name: 'Add test cards', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Add test cards', exact: true }).click();
  await expect(
    page.getByText('12 test cards added. Their artwork and card details are fictional.'),
  ).toBeVisible();
  await page.getByRole('button', { name: /^Collection/ }).click();
  await expect(page.locator('.group-tile')).toHaveCount(6);
  await expect(page.locator('.group-cover img').first()).toBeVisible();
  await page.getByRole('button', { name: 'Dismiss notification' }).click();
  await page.screenshot({ path: testInfo.outputPath('sets.png'), fullPage: true });
  await page
    .getByRole('button', {
      name: 'Open set NPB sample series, 2024 · BBM · Baseball card',
      exact: true,
    })
    .click();
  await expect(page.getByRole('heading', { name: 'NPB sample series', exact: true })).toBeVisible();
  await expect(page.locator('.collection.list .collection-card')).toHaveCount(2);
  await expect(page.getByRole('button', { name: 'Open Shohei Ohtani', exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('set-list.png'), fullPage: true });
  await page.getByRole('button', { name: 'All sets', exact: true }).click();
  await page.getByLabel('Search collection').fill('Hololive');
  await expect(page.locator('.group-tile')).toHaveCount(2);
  await page.getByRole('button', { name: /^All cards/ }).click();
  await expect(page.locator('.collection.list .collection-card')).toHaveCount(12);
  await page.screenshot({ path: testInfo.outputPath('all-cards.png'), fullPage: true });
  await page.getByLabel('Search collection').fill('大谷');
  await expect(page.locator('.collection-card')).toHaveCount(2);
  await page.getByRole('button', { name: /^Players/ }).click();
  await expect(page.locator('.group-tile')).toHaveCount(6);
  await page.screenshot({ path: testInfo.outputPath('players.png'), fullPage: true });
  await page.getByRole('button', { name: 'Open player Shohei Ohtani', exact: true }).click();
  await expect(page.locator('.collection-card')).toHaveCount(2);
  await expect(page.getByText('NPB sample series · #TEST-001', { exact: true })).toBeVisible();
  await expect(page.getByText('MLB sample collection · #TEST-001', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.reload();
  await expect(page.locator('.group-tile')).toHaveCount(6);
  await expect(page.getByRole('button', { name: 'Add test cards', exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.getByRole('button', { name: 'Backups & transfer', exact: true }).click();
  await page.getByRole('button', { name: 'Prepare full backup' }).click();
  await expect(page.getByText(/Package ready/)).toBeVisible();
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Save file', exact: true }).click();
  await (await downloaded).saveAs(testInfo.outputPath('test-cards.cardcabinet.zip'));
});
test('manual collection, Unicode, duplicates, recovery and offline reopen', async ({
  page,
  context,
  browserName,
}) => {
  await page.goto('./');
  await expect(page.getByRole('heading', { name: 'Your collection' })).toBeVisible();
  await page.getByRole('button', { name: 'Add your first card', exact: true }).click();
  await page.getByLabel('Player or character', { exact: true }).fill('Shohei Ohtani');
  await page.getByLabel('Original Japanese name').fill('大谷翔平');
  await page.getByLabel('Category', { exact: true }).fill('Japanese baseball');
  await page.getByLabel('Maker', { exact: true }).fill('BBM');
  await page.getByLabel('Card number', { exact: true }).fill('０１７');
  await page.getByRole('button', { name: 'Save card', exact: true }).click();
  await page.getByRole('button', { name: /^All cards/ }).click();
  await expect(page.getByRole('button', { name: 'Open Shohei Ohtani', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Open Shohei Ohtani', exact: true }).click();
  await page.getByRole('button', { name: 'Duplicate physical copy' }).click();
  await page.getByRole('button', { name: 'Close dialog' }).click();
  await expect(page.getByRole('button', { name: 'Open Shohei Ohtani', exact: true })).toHaveCount(
    2,
  );
  await page.getByLabel('Search collection').fill('017');
  await expect(page.getByRole('button', { name: 'Open Shohei Ohtani', exact: true })).toHaveCount(
    2,
  );
  await page.getByLabel('Search collection').fill('大谷');
  await expect(page.getByRole('button', { name: 'Open Shohei Ohtani', exact: true })).toHaveCount(
    2,
  );
  await page.getByRole('button', { name: 'Open Shohei Ohtani', exact: true }).first().click();
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Open Shohei Ohtani', exact: true })).toHaveCount(
    1,
  );
  await page.getByRole('button', { name: /Recently deleted/ }).click();
  await page.getByRole('button', { name: 'Open Shohei Ohtani', exact: true }).click();
  await page.getByRole('button', { name: 'Restore to collection' }).click();
  await page.getByRole('button', { name: 'Close dialog' }).click();
  await page.getByRole('button', { name: /^All cards/ }).click();
  await expect(page.getByRole('button', { name: 'Open Shohei Ohtani', exact: true })).toHaveCount(
    2,
  );
  if (browserName === 'chromium') {
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready;
    });
    await page.reload();
    await context.setOffline(true);
    await page.reload();
    await page.getByRole('button', { name: /^All cards/ }).click();
    await expect(page.getByRole('button', { name: 'Open Shohei Ohtani', exact: true })).toHaveCount(
      2,
    );
    await page.getByRole('button', { name: 'Add a card', exact: true }).click();
    await page.getByLabel('Player or character', { exact: true }).fill('Offline card');
    await page.getByRole('button', { name: 'Save card', exact: true }).click();
    await page.getByLabel('Search collection').fill('Offline');
    await expect(
      page.getByRole('button', { name: 'Open Offline card', exact: true }),
    ).toBeVisible();
    await context.setOffline(false);
  }
});
test('photo crop, backup download, repeat restore and draft survival', async ({
  page,
}, testInfo) => {
  await page.goto('./');
  await page.getByRole('button', { name: 'Add your first card', exact: true }).click();
  await page.getByLabel('Player or character', { exact: true }).fill('写真テスト');
  await page
    .locator('.photo-picker')
    .first()
    .locator('input[type=file]:not([capture])')
    .setInputFiles(path.resolve('tests/fixtures/card.jpg'));
  await expect(page.getByRole('heading', { name: 'Adjust front photo' })).toBeVisible();
  await page.getByRole('button', { name: 'Rotate 90°' }).click();
  await page.getByLabel('left', { exact: true }).fill('5');
  await page.getByRole('button', { name: 'Use photo', exact: true }).click();
  await expect(page.getByRole('img', { name: 'front of card', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Keep draft & close' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.reload();
  await page.getByRole('button', { name: 'Resume draft' }).click();
  await expect(page.getByLabel('Player or character', { exact: true })).toHaveValue('写真テスト');
  await page.getByRole('button', { name: 'Save card', exact: true }).click();
  await page.getByRole('button', { name: 'Backups & transfer', exact: true }).click();
  await page.getByRole('button', { name: 'Prepare full backup' }).click();
  await expect(page.getByText(/Package ready/)).toBeVisible();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Save file', exact: true }).click();
  const file = await downloadPromise;
  const backupPath = testInfo.outputPath('backup.zip');
  await file.saveAs(backupPath);
  await page.locator('input[type=file]').setInputFiles(backupPath);
  await expect(page.getByRole('heading', { name: 'Review backup import' })).toBeVisible();
  await expect(
    page.getByText('Already here, photos will be restored', { exact: false }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Import reviewed package' }).click();
  await page.getByRole('button', { name: /^All cards/ }).click();
  await expect(page.getByRole('button', { name: 'Open 写真テスト' })).toHaveCount(1);
  await expect(page.locator('.collection-card img')).toBeVisible();
});
test('project subpath, manifest, screenshots and no horizontal overflow', async ({
  page,
  request,
}, testInfo) => {
  const manifest = await (await request.get('manifest.webmanifest')).json();
  expect(manifest.start_url).toBe('/card-cabinet/');
  expect(manifest.scope).toBe('/card-cabinet/');
  await page.goto('./');
  await expect(page.getByRole('heading', { name: 'Your collection' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: testInfo.outputPath('collection.png'), fullPage: true });
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByText('Firebase is not configured yet.')).toBeVisible();
  const model = page.getByRole('combobox', { name: 'Identification model', exact: true });
  const reasoning = page.getByRole('combobox', { name: 'Reasoning effort', exact: true });
  await expect(model).toHaveValue('gpt-6-luna');
  await expect(reasoning).toHaveValue('low');
  await expect(model.locator('option')).toHaveText([
    'GPT-6 Luna',
    'GPT-6.1 Terra',
    'GPT-6.1 Sol',
    'GPT-6 Astra',
  ]);
  await expect(reasoning.locator('option')).toHaveText(['Low', 'Medium', 'High']);
  await model.selectOption('gpt-6-astra');
  await reasoning.selectOption('high');
  await expect(reasoning).toBeEnabled();
  await page.getByLabel('Enable Identify on this device').check();
  await expect(page.getByText('Identification enabled on this device.')).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(model).toHaveValue('gpt-6-astra');
  await expect(reasoning).toHaveValue('high');
  await expect(page.getByLabel('Enable Identify on this device')).toBeChecked();
  await expect(page.getByLabel('Unlimited attempts', { exact: true })).not.toBeChecked();
  await page.getByLabel('Unlimited attempts', { exact: true }).check();
  await expect(page.getByLabel('Daily attempt limit on this device')).toBeDisabled();
  await page.reload();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByLabel('Unlimited attempts', { exact: true })).toBeChecked();
  await page.getByLabel('Unlimited attempts', { exact: true }).uncheck();
  await expect(page.getByLabel('Daily attempt limit on this device')).toBeEnabled();
  for (const screen of ['Settings', 'Backups & transfer']) {
    await page.getByRole('button', { name: screen, exact: true }).click();
    await expect(page.getByRole('heading', { name: screen, exact: true })).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath(screen === 'Settings' ? 'settings.png' : 'backups.png'),
      fullPage: true,
    });
  }
});
