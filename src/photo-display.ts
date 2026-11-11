import { db, photoBlob, type CabinetDB, type Photo, type PhotoDisplay } from './db';
import { fullCrop, transformPhoto } from './photos';
import { frameCardPhoto } from './card-frame';

export type DisplayOptions = Pick<PhotoDisplay, 'mode' | 'rotation' | 'crop'>;
export const defaultDisplay: DisplayOptions = { mode: 'auto', rotation: 0, crop: fullCrop };
const pending = new Map<string, Promise<Blob>>();

export function rotateDisplay(options: DisplayOptions): DisplayOptions {
  const { left, top, right, bottom } = options.crop;
  return {
    mode: options.mode,
    rotation: (options.rotation + 90) % 360,
    crop:
      options.mode === 'manual'
        ? { left: 100 - bottom, top: left, right: 100 - top, bottom: right }
        : fullCrop,
  };
}

function valid(display?: PhotoDisplay): display is PhotoDisplay {
  return (
    !!display &&
    display.version === 1 &&
    ['auto', 'original', 'manual'].includes(display.mode) &&
    [0, 90, 180, 270].includes(display.rotation) &&
    !!display.crop &&
    Object.values(display.crop).every((v) => Number.isFinite(v) && v >= 0 && v <= 100) &&
    display.crop.right > display.crop.left &&
    display.crop.bottom > display.crop.top
  );
}

async function render(photo: Photo, options: DisplayOptions): Promise<Blob> {
  const original = photoBlob(photo);
  if (options.mode === 'original' && !options.rotation) return original;
  if (options.mode === 'manual')
    return transformPhoto(original, options.rotation, options.crop, 1600);
  const prepared =
    options.mode === 'auto' ? original : await transformPhoto(original, 0, fullCrop, 1600);
  const cropped = options.mode === 'auto' ? await frameCardPhoto(prepared) : prepared;
  return options.rotation ? transformPhoto(cropped, options.rotation, fullCrop, 1600) : cropped;
}

async function retainPreview(
  photo: Photo,
  options: DisplayOptions,
  blob: Blob,
  previous: number | undefined,
  database: CabinetDB,
) {
  const bytes = await blob.arrayBuffer();
  await database.transaction('rw', database.photos, database.photoDisplays, async () => {
    if (!(await database.photos.get(photo.hash))) return;
    const current = await database.photoDisplays.get(photo.hash);
    if (current?.updatedAt !== previous) return;
    await database.photoDisplays.put({
      mode: options.mode,
      rotation: options.rotation,
      crop: options.crop,
      hash: photo.hash,
      version: 1,
      bytes,
      type: blob.type,
      updatedAt: previous ?? Date.now(),
    });
    // Keep preferences for evicted previews. The original is always kept in photos.
    const cached = (await database.photoDisplays.orderBy('updatedAt').toArray()).filter(
      (row) => row.bytes,
    );
    let total = cached.reduce((sum, row) => sum + row.bytes!.byteLength, 0);
    for (const row of cached) {
      if (total <= 48 * 1024 * 1024) break;
      if (row.hash === photo.hash) continue;
      total -= row.bytes!.byteLength;
      delete row.bytes;
      await database.photoDisplays.put(row);
    }
  });
}

export function displayedPhoto(
  photo: Photo,
  saved?: PhotoDisplay,
  database: CabinetDB = db,
): Promise<Blob> {
  const display = saved?.hash === photo.hash && valid(saved) ? saved : undefined;
  if (display?.bytes instanceof ArrayBuffer && display.bytes.byteLength)
    return Promise.resolve(new Blob([display.bytes], { type: display.type || 'image/jpeg' }));
  if (display?.mode === 'original' && !display.rotation) return Promise.resolve(photoBlob(photo));
  const key = database.name + ':' + photo.hash + ':' + (display?.updatedAt ?? 0);
  const active = pending.get(key);
  if (active) return active;
  const result = render(photo, display ?? defaultDisplay)
    .then(async (blob) => {
      // A full disk must not prevent viewing the card or reading its original photo.
      await retainPreview(
        photo,
        display ?? defaultDisplay,
        blob,
        saved?.hash === photo.hash ? saved.updatedAt : undefined,
        database,
      ).catch(() => {});
      return blob;
    })
    .catch(() => photoBlob(photo))
    .finally(() => pending.delete(key));
  pending.set(key, result);
  return result;
}

export async function changePhotoDisplay(
  photo: Photo,
  options: DisplayOptions,
  database: CabinetDB = db,
) {
  const selected = await database.transaction(
    'rw',
    database.photos,
    database.photoDisplays,
    async () => {
      if (!(await database.photos.get(photo.hash)))
        throw new Error('This photo is no longer on this device.');
      const current = await database.photoDisplays.get(photo.hash);
      const choice: PhotoDisplay = {
        mode: options.mode,
        rotation: options.rotation,
        crop: { ...options.crop },
        hash: photo.hash,
        version: 1,
        updatedAt: Math.max(Date.now(), (current?.updatedAt ?? 0) + 1),
      };
      if (!valid(choice)) throw new Error('Choose a valid crop and rotation.');
      await database.photoDisplays.put(choice);
      return choice;
    },
  );
  const blob = await render(photo, options);
  await retainPreview(photo, options, blob, selected.updatedAt, database);
}

export async function croppedPreview(blob: Blob, maxEdge = 800) {
  const prepared = await transformPhoto(blob, 0, fullCrop, Math.max(maxEdge, 1600));
  const framed = await frameCardPhoto(prepared);
  return transformPhoto(framed, 0, fullCrop, maxEdge);
}
