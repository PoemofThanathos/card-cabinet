import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CabinetDB, makePhoto, type PhotoDisplay } from '../src/db';
import { frameCardPhoto, validFrameCorners, type NormalizedFrameCorners } from '../src/card-frame';
import {
  changePhotoDisplay,
  defaultDisplay,
  displayedPhoto,
  rotateDisplay,
} from '../src/photo-display';
import { transformPhoto } from '../src/photos';

vi.mock('../src/card-frame', async (original) => ({
  ...(await original<typeof import('../src/card-frame')>()),
  frameCardPhoto: vi.fn(async () => new Blob(['framed'], { type: 'image/jpeg' })),
}));
vi.mock('../src/photos', async (original) => ({
  ...(await original<typeof import('../src/photos')>()),
  transformPhoto: vi.fn(async () => new Blob(['rotated'], { type: 'image/jpeg' })),
}));

const corners: NormalizedFrameCorners = [
  { x: 0.1, y: 0.2 },
  { x: 0.9, y: 0.15 },
  { x: 0.85, y: 0.7 },
  { x: 0.05, y: 0.75 },
];
let database: CabinetDB;
beforeEach(async () => {
  vi.clearAllMocks();
  database = new CabinetDB('frame-preferences-' + crypto.randomUUID());
  await database.open();
});
afterEach(async () => {
  await database.delete();
});

it('keeps source-relative corners through rotation, cache eviction and regeneration', async () => {
  const photo = await makePhoto(new Blob(['source'], { type: 'image/jpeg' }));
  const other = await makePhoto(new Blob(['other'], { type: 'image/jpeg' }));
  await database.photos.bulkPut([photo, other]);
  const choice = { ...defaultDisplay, frameCorners: corners };
  const rotated = rotateDisplay(choice);
  expect(rotated.frameCorners).toEqual(corners);
  expect(rotated.rotation).toBe(90);
  await changePhotoDisplay(photo, rotated, database);
  const saved = (await database.photoDisplays.get(photo.hash))!;
  await database.photoDisplays.put({
    ...saved,
    updatedAt: 1,
    bytes: new ArrayBuffer(49 * 1024 * 1024),
  });
  await displayedPhoto(other, undefined, database);
  const evicted = (await database.photoDisplays.get(photo.hash))!;
  expect(evicted.bytes).toBeUndefined();
  expect(evicted.frameCorners).toEqual(corners);
  database.close();
  await database.open();
  await displayedPhoto(photo, evicted, database);
  expect(frameCardPhoto).toHaveBeenLastCalledWith(expect.any(Blob), corners);
  expect(transformPhoto).toHaveBeenLastCalledWith(expect.any(Blob), 90, defaultDisplay.crop, 1600);
  expect((await database.photoDisplays.get(photo.hash))?.frameCorners).toEqual(corners);
  expect(await database.photos.get(photo.hash)).toEqual(photo);
});

it.each(['manual', 'original'] as const)(
  'clears imported frame corners when selecting %s',
  async (mode) => {
    const photo = await makePhoto(new Blob(['source']));
    await database.photos.put(photo);
    await changePhotoDisplay(photo, { ...defaultDisplay, frameCorners: corners }, database);
    vi.clearAllMocks();
    await changePhotoDisplay(photo, { ...defaultDisplay, mode, frameCorners: corners }, database);
    expect((await database.photoDisplays.get(photo.hash))?.frameCorners).toBeUndefined();
    expect(frameCardPhoto).not.toHaveBeenCalled();
  },
);

it('rejects invalid imported geometry without replacing the saved choice', async () => {
  const photo = await makePhoto(new Blob(['source']));
  await database.photos.put(photo);
  await changePhotoDisplay(photo, { ...defaultDisplay, frameCorners: corners }, database);
  const saved = await database.photoDisplays.get(photo.hash);
  await expect(
    changePhotoDisplay(
      photo,
      { ...defaultDisplay, frameCorners: [corners[0], corners[2], corners[1], corners[3]] },
      database,
    ),
  ).rejects.toThrow('valid crop');
  expect(await database.photoDisplays.get(photo.hash)).toEqual(saved);
  const corrupt = {
    ...saved,
    frameCorners: [{ x: NaN, y: 0 }, ...corners.slice(1)],
  } as PhotoDisplay;
  await database.photoDisplays.put(corrupt);
  await displayedPhoto(photo, corrupt, database);
  expect(frameCardPhoto).toHaveBeenLastCalledWith(expect.any(Blob), undefined);
});

it('validates finite, bounded, convex clockwise quadrilaterals', () => {
  expect(validFrameCorners(corners)).toBe(true);
  for (const invalid of [
    null,
    [],
    corners.slice(1),
    [corners[0], corners[2], corners[1], corners[3]],
    [...corners].reverse(),
    [{ x: -0.1, y: 0 }, ...corners.slice(1)],
    [{ x: Infinity, y: 0 }, ...corners.slice(1)],
    Array(4).fill({ x: 0.2, y: 0.2 }),
    [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 0.2, y: 0.2 },
      { x: 0, y: 1 },
    ],
  ]) {
    expect(validFrameCorners(invalid)).toBe(false);
  }
});
