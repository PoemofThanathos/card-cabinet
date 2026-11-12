import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  CabinetDB,
  changeStatus,
  makePhoto,
  photoBlob,
  photoHash,
  purgeDeletedCards,
  saveCard,
  setSetting,
  setting,
  type Photo,
  type PhotoDisplay,
} from '../src/db';
import { newCard, purgedCard, type Card, type RemoteCard } from '../src/model';
import { syncCollection, type CloudStore } from '../src/sync';
import {
  changePhotoDisplay,
  defaultDisplay,
  displayedPhoto,
  rotateDisplay,
  type DisplayOptions,
} from '../src/photo-display';
import { frameCardPhoto } from '../src/card-frame';
import { fullCrop, transformPhoto } from '../src/photos';

vi.mock('../src/card-frame', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/card-frame')>()),
  frameCardPhoto: vi.fn(),
}));
vi.mock('../src/photos', () => ({
  fullCrop: { left: 0, top: 0, right: 100, bottom: 100 },
  transformPhoto: vi.fn(),
}));

let database: CabinetDB;
const image = readFileSync(new URL('./fixtures/card.jpg', import.meta.url));
const bytes = (buffer?: ArrayBuffer) => buffer && [...new Uint8Array(buffer)];
function jpeg(label: string) {
  const comment = new TextEncoder().encode(label);
  return new Blob(
    [
      image.subarray(0, 2),
      new Uint8Array([255, 254, (comment.length + 2) >> 8, (comment.length + 2) & 255]),
      comment,
      image.subarray(2),
    ],
    { type: 'image/jpeg' },
  );
}
const manual: DisplayOptions = {
  mode: 'manual',
  rotation: 90,
  crop: { left: 12, top: 8, right: 88, bottom: 95 },
};
function deferred() {
  let resolve!: (blob: Blob) => void;
  const promise = new Promise<Blob>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function fixture(status: Card['status'] = 'active') {
  const photo = await makePhoto(jpeg('original'));
  const card = newCard();
  card.status = status;
  card.fields.name = '大谷翔平';
  card.photos.front = photo.hash;
  await saveCard(card, [photo], database);
  return { card, photo };
}
async function unchangedOriginal(photo: Photo) {
  const stored = (await database.photos.get(photo.hash))!;
  expect(stored).toEqual(photo);
  expect(bytes(stored.bytes)).toEqual(bytes(photo.bytes));
  expect(await photoHash(photoBlob(stored))).toBe(photo.hash);
}
function remote(card: Card): RemoteCard {
  return { card, rev: 2, mutationId: crypto.randomUUID() };
}
beforeEach(async () => {
  database = new CabinetDB('photo-display-' + crypto.randomUUID());
  await database.open();
  vi.mocked(frameCardPhoto).mockReset().mockResolvedValue(jpeg('automatic preview'));
  vi.mocked(transformPhoto).mockReset().mockResolvedValue(jpeg('manual preview'));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await database.delete();
});

describe('derived photo previews', () => {
  it('caches a derived preview without changing the original hash, bytes, card or sync queue', async () => {
    const { card, photo } = await fixture();
    const beforeCard = await database.cards.get(card.id);
    const beforeQueue = await database.queue.get(card.id);
    const preview = await displayedPhoto(photo, undefined, database);
    const cached = (await database.photoDisplays.get(photo.hash))!;
    expect(cached).toMatchObject({ hash: photo.hash, version: 1, mode: 'auto', rotation: 0 });
    expect(bytes(cached.bytes)).toEqual(bytes(await preview.arrayBuffer()));
    expect(await photoHash(preview)).not.toBe(photo.hash);
    await unchangedOriginal(photo);
    expect(await database.cards.get(card.id)).toEqual(beforeCard);
    expect(await database.queue.get(card.id)).toEqual(beforeQueue);
    const reused = await displayedPhoto(photo, cached, database);
    expect(bytes(await reused.arrayBuffer())).toEqual(bytes(cached.bytes));
    expect(frameCardPhoto).toHaveBeenCalledTimes(1);
    expect(transformPhoto).not.toHaveBeenCalled();
  });

  it('retains manual crop and rotation across reopen and uses the saved preview', async () => {
    const { photo } = await fixture();
    await changePhotoDisplay(photo, manual, database);
    const selected = (await database.photoDisplays.get(photo.hash))!;
    expect(selected).toMatchObject(manual);
    expect(transformPhoto).toHaveBeenCalledWith(expect.any(Blob), 90, manual.crop, 1600);
    database.close();
    await database.open();
    const stored = (await database.photoDisplays.get(photo.hash))!;
    expect(bytes(await (await displayedPhoto(photo, stored, database)).arrayBuffer())).toEqual(
      bytes(selected.bytes),
    );
    expect(transformPhoto).toHaveBeenCalledTimes(1);
    expect(frameCardPhoto).not.toHaveBeenCalled();
    await unchangedOriginal(photo);
  });

  it('keeps original mode and its MIME type without automatic framing', async () => {
    const photo = await makePhoto(new Blob(['original png bytes'], { type: 'image/png' }));
    await database.photos.put(photo);
    await changePhotoDisplay(photo, { ...defaultDisplay, mode: 'original' }, database);
    const saved = (await database.photoDisplays.get(photo.hash))!;
    const result = await displayedPhoto(photo, saved, database);
    expect(result.type).toBe('image/png');
    expect(bytes(await result.arrayBuffer())).toEqual(bytes(photo.bytes));
    expect(saved.mode).toBe('original');
    expect(frameCardPhoto).not.toHaveBeenCalled();
    expect(transformPhoto).not.toHaveBeenCalled();
    await unchangedOriginal(photo);
  });

  it("ignores another photo's cached bytes and crop without changing either original", async () => {
    const { photo } = await fixture();
    const other = await makePhoto(jpeg('other original'));
    await database.photos.put(other);
    const saved: PhotoDisplay = {
      ...manual,
      hash: other.hash,
      version: 1,
      updatedAt: 7,
      bytes: await jpeg('other manual preview').arrayBuffer(),
      type: 'image/jpeg',
    };
    await database.photoDisplays.put(saved);

    const result = await displayedPhoto(photo, saved, database);

    expect(bytes(await result.arrayBuffer())).toEqual(
      bytes(await jpeg('automatic preview').arrayBuffer()),
    );
    expect(bytes(await result.arrayBuffer())).not.toEqual(bytes(saved.bytes));
    expect(frameCardPhoto).toHaveBeenCalledTimes(1);
    expect(bytes(await vi.mocked(frameCardPhoto).mock.calls[0][0].arrayBuffer())).toEqual(
      bytes(photo.bytes),
    );
    expect(transformPhoto).not.toHaveBeenCalled();
    expect(await database.photoDisplays.get(photo.hash)).toMatchObject({
      ...defaultDisplay,
      hash: photo.hash,
    });
    const otherSaved = (await database.photoDisplays.get(other.hash))!;
    expect(otherSaved).toEqual(saved);
    expect(bytes(otherSaved.bytes)).toEqual(bytes(saved.bytes));
    await unchangedOriginal(photo);
    await unchangedOriginal(other);
  });

  it.each([
    { version: 2 },
    { rotation: 45 },
    { crop: { left: 90, top: 0, right: 10, bottom: 100 } },
    { crop: { left: -1, top: 0, right: 100, bottom: 100 } },
  ])('ignores invalid display metadata and its cached bytes: %j', async (invalid) => {
    const { photo } = await fixture();
    const saved = {
      ...defaultDisplay,
      hash: photo.hash,
      version: 1,
      updatedAt: 1,
      bytes: await jpeg('stale invalid cache').arrayBuffer(),
      ...invalid,
    } as PhotoDisplay;
    await database.photoDisplays.put(saved);
    const result = await displayedPhoto(photo, saved, database);
    expect(bytes(await result.arrayBuffer())).toEqual(
      bytes(await jpeg('automatic preview').arrayBuffer()),
    );
    expect(frameCardPhoto).toHaveBeenCalledTimes(1);
    expect(await database.photoDisplays.get(photo.hash)).toMatchObject({
      version: 1,
      ...defaultDisplay,
    });
    await unchangedOriginal(photo);
  });

  it('falls back to the original after a framing failure and allows a later retry', async () => {
    const { photo } = await fixture();
    vi.mocked(frameCardPhoto).mockRejectedValueOnce(new Error('Unreadable preview'));
    expect(bytes(await (await displayedPhoto(photo, undefined, database)).arrayBuffer())).toEqual(
      bytes(photo.bytes),
    );
    expect(await database.photoDisplays.get(photo.hash)).toBeUndefined();
    await displayedPhoto(photo, undefined, database);
    expect(frameCardPhoto).toHaveBeenCalledTimes(2);
    expect((await database.photoDisplays.get(photo.hash))?.bytes).toBeDefined();
    await unchangedOriginal(photo);
  });

  it('keeps manual preferences and falls back to the original if regeneration fails', async () => {
    const { photo } = await fixture();
    const saved: PhotoDisplay = { ...manual, hash: photo.hash, version: 1, updatedAt: 12 };
    await database.photoDisplays.put(saved);
    vi.mocked(transformPhoto).mockRejectedValueOnce(new Error('Canvas unavailable'));
    expect(bytes(await (await displayedPhoto(photo, saved, database)).arrayBuffer())).toEqual(
      bytes(photo.bytes),
    );
    expect(await database.photoDisplays.get(photo.hash)).toEqual(saved);
    await unchangedOriginal(photo);
  });

  it('keeps viewing usable when the preview cache hits a storage quota', async () => {
    const { photo } = await fixture();
    const write = vi.spyOn(database.photoDisplays, 'put').mockImplementation(() => {
      throw new DOMException('No space', 'QuotaExceededError');
    });
    const result = await displayedPhoto(photo, undefined, database);
    expect(bytes(await result.arrayBuffer())).toEqual(
      bytes(await jpeg('automatic preview').arrayBuffer()),
    );
    expect(await database.photoDisplays.get(photo.hash)).toBeUndefined();
    await unchangedOriginal(photo);
    write.mockRestore();
    await displayedPhoto(photo, undefined, database);
    expect((await database.photoDisplays.get(photo.hash))?.bytes).toBeDefined();
  });

  it('evicts old preview bytes at the cache budget while retaining crop preferences and originals', async () => {
    const { photo } = await fixture();
    const oldest = await makePhoto(jpeg('older original'));
    const newer = await makePhoto(jpeg('newer original'));
    await database.photos.bulkPut([oldest, newer]);
    await database.photoDisplays.bulkPut([
      {
        ...manual,
        hash: oldest.hash,
        version: 1,
        updatedAt: 1,
        bytes: new ArrayBuffer(30 * 1024 * 1024),
      },
      {
        ...defaultDisplay,
        hash: newer.hash,
        version: 1,
        updatedAt: 2,
        bytes: new ArrayBuffer(20 * 1024 * 1024),
      },
    ]);
    await displayedPhoto(photo, undefined, database);
    const evicted = (await database.photoDisplays.get(oldest.hash))!;
    expect(evicted).toMatchObject(manual);
    expect(evicted.bytes).toBeUndefined();
    expect((await database.photoDisplays.get(newer.hash))?.bytes?.byteLength).toBe(
      20 * 1024 * 1024,
    );
    await unchangedOriginal(oldest);
    await unchangedOriginal(newer);
    await displayedPhoto(oldest, evicted, database);
    expect(transformPhoto).toHaveBeenCalledWith(
      expect.any(Blob),
      manual.rotation,
      manual.crop,
      1600,
    );
    expect((await database.photoDisplays.get(oldest.hash))?.bytes).toBeDefined();
  });

  it('rejects an invalid user crop without replacing the saved choice', async () => {
    const { photo } = await fixture();
    await changePhotoDisplay(photo, manual, database);
    const saved = await database.photoDisplays.get(photo.hash);
    await expect(
      changePhotoDisplay(
        photo,
        {
          ...manual,
          crop: { left: 40, top: 0, right: 40, bottom: 100 },
        },
        database,
      ),
    ).rejects.toThrow('valid crop');
    expect(await database.photoDisplays.get(photo.hash)).toEqual(saved);
    expect(transformPhoto).toHaveBeenCalledTimes(1);
    await unchangedOriginal(photo);
  });

  it('deduplicates an in-flight preview without sharing it with a different database', async () => {
    const { photo } = await fixture();
    const other = new CabinetDB('photo-display-other-' + crypto.randomUUID());
    try {
      await other.photos.put(photo);
      const render = deferred();
      vi.mocked(frameCardPhoto).mockReturnValueOnce(render.promise);
      const first = displayedPhoto(photo, undefined, database);
      const again = displayedPhoto(photo, undefined, database);
      expect(again).toBe(first);
      await displayedPhoto(photo, undefined, other);
      expect(frameCardPhoto).toHaveBeenCalledTimes(2);
      render.resolve(jpeg('first database'));
      await first;
      expect(bytes((await database.photoDisplays.get(photo.hash))?.bytes)).not.toEqual(
        bytes((await other.photoDisplays.get(photo.hash))?.bytes),
      );
    } finally {
      await other.delete();
    }
  });
});

describe('preview choice races', () => {
  it('does not let background framing finish over a pending user crop', async () => {
    const { photo } = await fixture();
    const automatic = deferred();
    const userCrop = deferred();
    vi.mocked(frameCardPhoto).mockReturnValueOnce(automatic.promise);
    vi.mocked(transformPhoto).mockReturnValueOnce(userCrop.promise);
    const viewing = displayedPhoto(photo, undefined, database);
    const changing = changePhotoDisplay(photo, manual, database);
    await vi.waitFor(() => expect(transformPhoto).toHaveBeenCalledTimes(1));
    automatic.resolve(jpeg('old auto crop'));
    await viewing;
    expect(await database.photoDisplays.get(photo.hash)).toMatchObject(manual);
    userCrop.resolve(jpeg('chosen manual crop'));
    await changing;
    const selected = (await database.photoDisplays.get(photo.hash))!;
    expect(selected).toMatchObject(manual);
    expect(bytes(selected.bytes)).toEqual(bytes(await jpeg('chosen manual crop').arrayBuffer()));
    await unchangedOriginal(photo);
  });

  it('keeps the latest user choice when an older manual render completes later', async () => {
    const { photo } = await fixture();
    const older = deferred();
    vi.mocked(transformPhoto).mockReturnValueOnce(older.promise);
    const first = changePhotoDisplay(photo, manual, database);
    await vi.waitFor(() => expect(transformPhoto).toHaveBeenCalledTimes(1));
    await changePhotoDisplay(photo, { ...defaultDisplay, mode: 'original' }, database);
    const selected = await database.photoDisplays.get(photo.hash);
    older.resolve(jpeg('obsolete manual crop'));
    await first;
    expect(await database.photoDisplays.get(photo.hash)).toEqual(selected);
    expect(selected?.mode).toBe('original');
  });

  it('advances the choice revision even when two writes share the same millisecond', async () => {
    const { photo } = await fixture();
    const now = 1800000000000;
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const saved: PhotoDisplay = { ...defaultDisplay, hash: photo.hash, version: 1, updatedAt: now };
    await database.photoDisplays.put(saved);
    const older = deferred();
    vi.mocked(frameCardPhoto).mockReturnValueOnce(older.promise);
    const viewing = displayedPhoto(photo, saved, database);
    await changePhotoDisplay(photo, { ...defaultDisplay, mode: 'original' }, database);
    const selected = (await database.photoDisplays.get(photo.hash))!;
    expect(selected.updatedAt).toBeGreaterThan(now);
    older.resolve(jpeg('obsolete auto crop'));
    await viewing;
    expect(await database.photoDisplays.get(photo.hash)).toEqual(selected);
  });

  it('rotates a manual crop around the same part of the original image', () => {
    const once = rotateDisplay(manual);
    expect(once).toEqual({
      mode: 'manual',
      rotation: 180,
      crop: { left: 5, top: 12, right: 92, bottom: 88 },
    });
    let current = manual;
    for (let n = 0; n < 4; n++) current = rotateDisplay(current);
    expect(current).toEqual(manual);
    expect(rotateDisplay({ ...defaultDisplay, rotation: 270 })).toEqual(defaultDisplay);
  });
});

describe('preview cleanup on permanent deletion', () => {
  it.each(['bin', 'save'] as const)(
    'removes the original and cache atomically through %s',
    async (path) => {
      const { card, photo } = await fixture('deleted');
      await displayedPhoto(photo, undefined, database);
      expect(await database.photoDisplays.count()).toBe(1);
      if (path === 'bin') expect(await purgeDeletedCards([card.id], database)).toBe(1);
      else await saveCard(purgedCard(card), [], database);
      expect((await database.cards.get(card.id))?.status).toBe('purged');
      expect((await database.queue.get(card.id))?.card.status).toBe('purged');
      expect(await database.photos.get(photo.hash)).toBeUndefined();
      expect(await database.photoDisplays.get(photo.hash)).toBeUndefined();
    },
  );

  it('rolls back the purge if deleting the cache fails', async () => {
    const { card, photo } = await fixture('deleted');
    await displayedPhoto(photo, undefined, database);
    const before = {
      card: await database.cards.get(card.id),
      queued: await database.queue.get(card.id),
      display: await database.photoDisplays.get(photo.hash),
    };
    vi.spyOn(database.photoDisplays, 'bulkDelete').mockImplementation(() => {
      throw new Error('Cache deletion failed');
    });
    await expect(purgeDeletedCards([card.id], database)).rejects.toThrow('Cache deletion failed');
    expect(await database.cards.get(card.id)).toEqual(before.card);
    expect(await database.queue.get(card.id)).toEqual(before.queued);
    expect(await database.photoDisplays.get(photo.hash)).toEqual(before.display);
    await unchangedOriginal(photo);
  });

  it('retains a shared photo and preview until the last physical copy is purged', async () => {
    const { card, photo } = await fixture('deleted');
    const shared = { ...newCard(), photos: { front: photo.hash, back: null } };
    await saveCard(shared, [], database);
    await displayedPhoto(photo, undefined, database);
    const cached = await database.photoDisplays.get(photo.hash);
    await purgeDeletedCards([card.id], database);
    await unchangedOriginal(photo);
    expect(await database.photoDisplays.get(photo.hash)).toEqual(cached);
    await changeStatus(shared, 'deleted', database);
    await purgeDeletedCards([shared.id], database);
    expect(await database.photos.get(photo.hash)).toBeUndefined();
    expect(await database.photoDisplays.get(photo.hash)).toBeUndefined();
  });

  it.each(['automatic', 'manual'] as const)(
    'does not resurrect a purged photo when %s rendering finishes',
    async (mode) => {
      const { card, photo } = await fixture('deleted');
      const rendering = deferred();
      const renderer = mode === 'automatic' ? vi.mocked(frameCardPhoto) : vi.mocked(transformPhoto);
      renderer.mockReturnValueOnce(rendering.promise);
      const result =
        mode === 'automatic'
          ? displayedPhoto(photo, undefined, database)
          : changePhotoDisplay(photo, manual, database);
      await vi.waitFor(() => expect(renderer).toHaveBeenCalledTimes(1));
      await purgeDeletedCards([card.id], database);
      rendering.resolve(jpeg('late preview'));
      await result;
      expect(await database.photos.get(photo.hash)).toBeUndefined();
      expect(await database.photoDisplays.get(photo.hash)).toBeUndefined();
      await expect(changePhotoDisplay(photo, manual, database)).rejects.toThrow('no longer');
    },
  );

  it.each(['commit', 'pull'] as const)(
    'removes cache after a remote purge received through %s',
    async (path) => {
      const { card, photo } = await fixture();
      await setSetting('ownerUid', 'owner', database);
      if (path === 'pull') await database.queue.clear();
      await displayedPhoto(photo, undefined, database);
      const tombstone = remote(purgedCard(card));
      const cloud: CloudStore = {
        commit: vi.fn(async () => ({ ok: false, remote: tombstone })),
        async *list() {
          yield tombstone;
        },
      };
      expect(await syncCollection(cloud, 'owner', database)).toBe(0);
      expect(cloud.commit).toHaveBeenCalledTimes(path === 'commit' ? 1 : 0);
      expect((await database.cards.get(card.id))?.status).toBe('purged');
      expect(await database.photos.get(photo.hash)).toBeUndefined();
      expect(await database.photoDisplays.get(photo.hash)).toBeUndefined();
      expect(await setting('purgePhotoCandidates', null, database)).toBeNull();
    },
  );

  it('keeps the preview when a later cloud record introduces a surviving shared copy', async () => {
    const { card, photo } = await fixture();
    await setSetting('ownerUid', 'owner', database);
    await database.queue.clear();
    await displayedPhoto(photo, undefined, database);
    const preview = await database.photoDisplays.get(photo.hash);
    const survivor = { ...newCard(), photos: { front: photo.hash, back: null } };
    const cloud: CloudStore = {
      commit: async () => {
        throw new Error('Unexpected commit');
      },
      async *list() {
        yield remote(purgedCard(card));
        expect(await database.photoDisplays.get(photo.hash)).toEqual(preview);
        yield remote(survivor);
      },
    };
    await syncCollection(cloud, 'owner', database);
    await unchangedOriginal(photo);
    expect(await database.photoDisplays.get(photo.hash)).toEqual(preview);
  });

  it('retains deferred originals and cache after an interrupted pull until a complete retry', async () => {
    const { card, photo } = await fixture();
    await setSetting('ownerUid', 'owner', database);
    await database.queue.clear();
    await displayedPhoto(photo, undefined, database);
    const cached = await database.photoDisplays.get(photo.hash);
    const tombstone = remote(purgedCard(card));
    const cloud: CloudStore = {
      commit: async () => {
        throw new Error('Unexpected commit');
      },
      async *list() {
        yield tombstone;
        throw new Error('Interrupted pull');
      },
    };
    await expect(syncCollection(cloud, 'owner', database)).rejects.toThrow('Interrupted pull');
    await unchangedOriginal(photo);
    expect(await database.photoDisplays.get(photo.hash)).toEqual(cached);
    database.close();
    await database.open();
    cloud.list = async function* () {
      yield tombstone;
    };
    await syncCollection(cloud, 'owner', database);
    expect(await database.photos.get(photo.hash)).toBeUndefined();
    expect(await database.photoDisplays.get(photo.hash)).toBeUndefined();
    expect(await setting('purgePhotoCandidates', null, database)).toBeNull();
  });
});
