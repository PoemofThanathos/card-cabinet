import { afterEach, beforeEach, expect, it } from 'vitest';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { CabinetDB, makePhoto, saveCard } from '../src/db';
import { newCard, purgedCard } from '../src/model';
import { applyImport, exportPackage, planImport, readPackage } from '../src/backup';

let source: CabinetDB;
let target: CabinetDB;
beforeEach(async () => {
  source = new CabinetDB('backup-source-' + crypto.randomUUID());
  target = new CabinetDB('backup-target-' + crypto.randomUUID());
  await Promise.all([source.open(), target.open()]);
});
afterEach(async () => {
  await Promise.all([source.delete(), target.delete()]);
});
const corners = [
  { x: 0.1, y: 0.1 },
  { x: 0.9, y: 0.1 },
  { x: 0.9, y: 0.9 },
  { x: 0.1, y: 0.9 },
] as const;
async function fixture() {
  const photo = await makePhoto(
    new Blob([new Uint8Array([255, 216, 3, 4, 255, 217])], { type: 'image/jpeg' }),
  );
  const card = newCard();
  card.photos.front = photo.hash;
  await saveCard(card, [photo], source);
  await source.photoDisplays.put({
    hash: photo.hash,
    version: 1,
    mode: 'auto',
    rotation: 90,
    crop: { left: 0, top: 0, right: 100, bottom: 100 },
    frameCorners: [...corners],
    bytes: new Uint8Array([1, 2, 3]).buffer,
    type: 'image/jpeg',
    updatedAt: 1,
  });
  return { card, photo };
}
async function rewrite(blob: Blob, change: (manifest: any) => void) {
  const files = unzipSync(new Uint8Array(await blob.arrayBuffer()));
  const manifest = JSON.parse(strFromU8(files['manifest.json']));
  change(manifest);
  files['manifest.json'] = strToU8(JSON.stringify(manifest));
  return new Blob([zipSync(files) as Uint8Array<ArrayBuffer>]);
}
it('round trips frame and rotation without derived image bytes or altered original', async () => {
  const { card, photo } = await fixture();
  const blob = await exportPackage([card], source);
  const files = unzipSync(new Uint8Array(await blob.arrayBuffer()));
  const manifest = JSON.parse(strFromU8(files['manifest.json']));
  expect(manifest.photoDisplays[0]).toMatchObject({ frameCorners: corners, rotation: 90 });
  expect(manifest.photoDisplays[0]).not.toHaveProperty('bytes');
  expect([...files['photos/' + photo.hash + '.jpg']]).toEqual([...new Uint8Array(photo.bytes)]);
  const pack = await readPackage(blob);
  await applyImport(pack, await planImport(pack, target), target);
  expect(await target.photoDisplays.get(photo.hash)).toMatchObject({
    frameCorners: corners,
    rotation: 90,
  });
  expect((await target.photoDisplays.get(photo.hash))?.bytes).toBeUndefined();
  expect([...new Uint8Array((await target.photos.get(photo.hash))!.bytes)]).toEqual([
    ...new Uint8Array(photo.bytes),
  ]);
});
it('rejects invalid and dangling preferences and accepts older manifests', async () => {
  const { card } = await fixture();
  const blob = await exportPackage([card], source);
  for (const mutate of [
    (m: any) => {
      m.photoDisplays[0].rotation = 45;
    },
    (m: any) => {
      m.photoDisplays[0].frameCorners[1] = m.photoDisplays[0].frameCorners[0];
    },
    (m: any) => {
      m.photoDisplays[0].crop.right = -1;
    },
    (m: any) => {
      m.photoDisplays[0].hash = 'a'.repeat(64);
    },
  ])
    await expect(readPackage(await rewrite(blob, mutate))).rejects.toThrow();
  const old = await readPackage(
    await rewrite(blob, (m) => {
      delete m.photoDisplays;
    }),
  );
  expect(old.photoDisplays).toBeUndefined();
});
it('keeps local preference when keeping a card and replaces it only on explicit replace', async () => {
  const { card, photo } = await fixture();
  const pack = await readPackage(await exportPackage([card], source));
  const local = structuredClone(card);
  local.fields.name = 'Local';
  await saveCard(local, [photo], target);
  const existing = {
    hash: photo.hash,
    version: 1 as const,
    mode: 'original' as const,
    rotation: 0,
    crop: { left: 0, top: 0, right: 100, bottom: 100 },
    updatedAt: 9,
  };
  await target.photoDisplays.put(existing);
  const rows = await planImport(pack, target);
  await applyImport(pack, rows, target);
  expect(await target.photoDisplays.get(photo.hash)).toEqual(existing);
  const replace = await planImport(pack, target);
  replace[0].choice = 'replace';
  await applyImport(pack, replace, target);
  expect(await target.photoDisplays.get(photo.hash)).toMatchObject({
    mode: 'auto',
    rotation: 90,
    frameCorners: corners,
  });
});
it('exports no invalid stored preference and skips a purged card preference', async () => {
  const { card, photo } = await fixture();
  await source.photoDisplays.update(photo.hash, { rotation: 45 });
  expect((await readPackage(await exportPackage([card], source))).photoDisplays).toEqual([]);
  await source.photoDisplays.update(photo.hash, { rotation: 90 });
  const pack = await readPackage(await exportPackage([card], source));
  await saveCard(card, [photo], target);
  await target.cards.update(card.id, purgedCard(card));
  await applyImport(pack, await planImport(pack, target), target);
  expect(await target.photoDisplays.get(photo.hash)).toBeUndefined();
});
