import { isHeifPhoto } from './heic-format';

async function loadNativeImage(blob: Blob): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(blob);
  const image = new Image();
  try {
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () =>
        reject(
          new Error(
            'This photo could not be read. Choose another photo or export it as JPEG or PNG.',
          ),
        );
      image.src = url;
    });
    return image;
  } finally {
    URL.revokeObjectURL(url);
  }
}
export async function loadImage(blob: Blob): Promise<HTMLImageElement> {
  try {
    return await loadNativeImage(blob);
  } catch (error) {
    if (!(await isHeifPhoto(blob))) throw error;
    const { decodeHeic } = await import('./heic');
    return loadNativeImage(await decodeHeic(blob));
  }
}
export type Crop = { left: number; top: number; right: number; bottom: number };
export const fullCrop: Crop = { left: 0, top: 0, right: 100, bottom: 100 };
export type PhotoProcessingOptions = { concurrency?: number };
export function photoProcessingCapabilities() {
  const device = globalThis.navigator as (Navigator & { deviceMemory?: number }) | undefined;
  const cores = device?.hardwareConcurrency;
  return {
    maxConcurrency: cores && cores < 4 ? 2 : 4,
    memoryBudgetMiB: (device?.deviceMemory ?? 0) >= 8 ? 256 : 128,
    heicConcurrency: 1 as const,
  };
}
type PhotoTask = {
  limit: number;
  bytes: number;
  run: () => Promise<Blob>;
  resolve: (blob: Blob) => void;
  reject: (error: unknown) => void;
};
const photoTasks: PhotoTask[] = [];
const activePhotoTasks = new Set<PhotoTask>();
let allocatedBytes = 0;
function pumpPhotos() {
  const { maxConcurrency, memoryBudgetMiB } = photoProcessingCapabilities();
  const budget = memoryBudgetMiB * 1024 * 1024;
  while (photoTasks.length) {
    const task = photoTasks[0];
    const limit = Math.min(
      maxConcurrency,
      task.limit,
      ...[...activePhotoTasks].map((active) => active.limit),
    );
    if (
      activePhotoTasks.size >= limit ||
      (activePhotoTasks.size > 0 && allocatedBytes + task.bytes > budget)
    )
      return;
    photoTasks.shift();
    activePhotoTasks.add(task);
    allocatedBytes += task.bytes;
    void task
      .run()
      .then(task.resolve, task.reject)
      .finally(() => {
        activePhotoTasks.delete(task);
        allocatedBytes -= task.bytes;
        pumpPhotos();
      });
  }
}

async function nativeDimensions(blob: Blob): Promise<[number, number] | null> {
  const bytes = new Uint8Array(await blob.slice(0, 256 * 1024).arrayBuffer());
  const view = new DataView(bytes.buffer);
  if (
    bytes.length >= 24 &&
    view.getUint32(0) === 0x89504e47 &&
    view.getUint32(4) === 0x0d0a1a0a &&
    view.getUint32(12) === 0x49484452
  )
    return [view.getUint32(16), view.getUint32(20)];
  if (bytes[0] !== 255 || bytes[1] !== 216) return null;
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset++] !== 255) return null;
    while (bytes[offset] === 255) offset++;
    const marker = bytes[offset++];
    if (marker === 0xda || marker === 0xd9) return null;
    if (marker === 1 || (marker >= 0xd0 && marker <= 0xd8)) continue;
    if (offset + 2 > bytes.length) return null;
    const length = view.getUint16(offset);
    if (length < 2 || offset + length > bytes.length) return null;
    if (
      [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(
        marker,
      ) &&
      length >= 7
    )
      return [view.getUint16(offset + 5), view.getUint16(offset + 3)];
    offset += length;
  }
  return null;
}

const recentTransforms: { source: Blob; key: string; result: Blob }[] = [];
const pendingTransforms = new Map<Blob, Map<string, Promise<Blob>>>();
export function transformPhoto(
  blob: Blob,
  rotation = 0,
  crop: Crop = fullCrop,
  maxEdge = 2560,
  options: PhotoProcessingOptions = {},
): Promise<Blob> {
  const key = JSON.stringify([rotation, crop.left, crop.top, crop.right, crop.bottom, maxEdge]);
  const cached = recentTransforms.find((item) => item.source === blob && item.key === key);
  if (cached) return Promise.resolve(cached.result);
  const pending = pendingTransforms.get(blob)?.get(key);
  if (pending) return pending;
  const run = async () => {
    if (blob.size > 40 * 1024 * 1024)
      throw new Error('This image is larger than 40 MB. Choose a smaller image.');
    const dimensions = (await isHeifPhoto(blob)) ? null : await nativeDimensions(blob);
    const pixels = dimensions ? dimensions[0] * dimensions[1] : 0;
    if (pixels > 60_000_000)
      throw new Error('This image is too large to edit safely on a phone. Choose a smaller image.');
    const known = dimensions && pixels > 0;
    const stagePixels = known ? pixels * Math.min(1, 3200 / Math.max(...dimensions)) ** 2 : 0;
    // Include the decoded source, both canvases and headroom for browser copies.
    const bytes = known
      ? Math.ceil((pixels + stagePixels + Math.min(stagePixels, maxEdge ** 2)) * 5)
      : photoProcessingCapabilities().memoryBudgetMiB * 1024 * 1024;
    const limit = known ? Math.max(1, Math.min(4, Math.floor(options.concurrency || 1))) : 1;
    return new Promise<Blob>((resolve, reject) => {
      photoTasks.push({
        limit,
        bytes,
        run: () => transformOnePhoto(blob, rotation, crop, maxEdge),
        resolve,
        reject,
      });
      pumpPhotos();
    });
  };
  const result = run()
    .then((converted) => {
      recentTransforms.push({ source: blob, key, result: converted });
      while (
        recentTransforms.length > 4 ||
        recentTransforms.reduce((size, item) => size + item.result.size, 0) > 12 * 1024 * 1024
      )
        recentTransforms.shift();
      return converted;
    })
    .finally(() => {
      const variants = pendingTransforms.get(blob);
      variants?.delete(key);
      if (!variants?.size) pendingTransforms.delete(blob);
    });
  const variants = pendingTransforms.get(blob) ?? new Map<string, Promise<Blob>>();
  variants.set(key, result);
  pendingTransforms.set(blob, variants);
  return result;
}
async function transformOnePhoto(blob: Blob, rotation: number, crop: Crop, maxEdge: number) {
  if (blob.size > 40 * 1024 * 1024)
    throw new Error('This image is larger than 40 MB. Choose a smaller image.');
  const image = await loadImage(blob);
  let stage: HTMLCanvasElement | undefined;
  let out: HTMLCanvasElement | undefined;
  try {
    const iw = image.naturalWidth,
      ih = image.naturalHeight;
    if (iw * ih > 60000000)
      throw new Error('This image is too large to edit safely on a phone. Choose a smaller image.');
    const turned = rotation % 180 !== 0;
    const scale = Math.min(1, 3200 / Math.max(iw, ih));
    stage = document.createElement('canvas');
    stage.width = Math.round((turned ? ih : iw) * scale);
    stage.height = Math.round((turned ? iw : ih) * scale);
    const s = stage.getContext('2d')!;
    s.fillStyle = '#fff';
    s.fillRect(0, 0, stage.width, stage.height);
    s.translate(stage.width / 2, stage.height / 2);
    s.rotate((rotation * Math.PI) / 180);
    s.drawImage(image, (-iw * scale) / 2, (-ih * scale) / 2, iw * scale, ih * scale);
    const w = (stage.width * (crop.right - crop.left)) / 100,
      h = (stage.height * (crop.bottom - crop.top)) / 100;
    if (w < 100 || h < 100) throw new Error('Keep a crop at least 100 pixels wide and high.');
    const factor = Math.min(1, maxEdge / Math.max(w, h));
    out = document.createElement('canvas');
    out.width = Math.round(w * factor);
    out.height = Math.round(h * factor);
    out
      .getContext('2d')!
      .drawImage(
        stage,
        (stage.width * crop.left) / 100,
        (stage.height * crop.top) / 100,
        w,
        h,
        0,
        0,
        out.width,
        out.height,
      );
    const encoded = await new Promise<Blob>((resolve, reject) =>
      out!.toBlob(
        (b) => (b ? resolve(b) : reject(new Error('Could not encode the photo.'))),
        'image/jpeg',
        0.92,
      ),
    );
    return encoded; // Canvas creates a new JPEG, without EXIF/GPS metadata.
  } finally {
    if (stage) stage.width = stage.height = 1;
    if (out) out.width = out.height = 1;
    image.src = '';
  }
}
export async function transmittedPhoto(blob: Blob) {
  const clean = await transformPhoto(blob, 0, fullCrop, 2560);
  if (clean.size > 2500000)
    throw new Error(
      'Photo is too detailed for the scan limit. Crop closer to the card and try again.',
    );
  return new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = reject;
    r.readAsDataURL(clean);
  });
}
