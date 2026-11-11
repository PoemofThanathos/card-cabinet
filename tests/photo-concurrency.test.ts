import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const urls = new Map<string, Blob>();
const sizes = new WeakMap<Blob, [number, number]>();
let active = 0,
  maximum = 0;
let encodings: { width: number; height: number; quality?: number; type?: string }[];
class TestImage {
  naturalWidth = 0;
  naturalHeight = 0;
  onload?: () => void;
  onerror?: () => void;
  live = false;
  set src(url: string) {
    if (!url) {
      if (this.live) active--;
      this.live = false;
      return;
    }
    const source = urls.get(url)!;
    [this.naturalWidth, this.naturalHeight] = sizes.get(source) ?? [800, 1000];
    this.live = true;
    maximum = Math.max(maximum, ++active);
    queueMicrotask(() => this.onload?.());
  }
}
class TestCanvas {
  width = 0;
  height = 0;
  getContext() {
    return { fillRect() {}, translate() {}, rotate() {}, drawImage() {} };
  }
  toBlob(callback: (blob: Blob) => void, type?: string, quality?: number) {
    encodings.push({ width: this.width, height: this.height, type, quality });
    setTimeout(() => callback(new Blob(['encoded'], { type })), 2);
  }
}
function png(width = 800, height = 1000) {
  const bytes = new Uint8Array(24);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x89504e47);
  view.setUint32(4, 0x0d0a1a0a);
  view.setUint32(12, 0x49484452);
  view.setUint32(16, width);
  view.setUint32(20, height);
  const blob = new Blob([bytes], { type: 'image/png' });
  sizes.set(blob, [width, height]);
  return blob;
}
beforeEach(() => {
  vi.resetModules();
  active = maximum = 0;
  encodings = [];
  urls.clear();
  vi.stubGlobal('navigator', { hardwareConcurrency: 8, deviceMemory: 4 });
  vi.stubGlobal('Image', TestImage);
  vi.stubGlobal('document', { createElement: () => new TestCanvas() });
  vi.spyOn(URL, 'createObjectURL').mockImplementation((source) => {
    const url = 'blob:' + crypto.randomUUID();
    urls.set(url, source as Blob);
    return url;
  });
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation((url) => {
    urls.delete(url);
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each([1, 2, 4])(
  'limits native decode/canvas work to %i simultaneous small images',
  async (concurrency) => {
    const { transformPhoto, fullCrop } = await import('../src/photos');
    await Promise.all(
      Array.from({ length: 12 }, () => transformPhoto(png(), 0, fullCrop, 2560, { concurrency })),
    );
    expect(maximum).toBe(concurrency);
    expect(active).toBe(0);
    expect(urls.size).toBe(0);
    expect(
      encodings.every(
        (encoded) =>
          encoded.type === 'image/jpeg' &&
          encoded.quality === 0.92 &&
          encoded.width === 800 &&
          encoded.height === 1000,
      ),
    ).toBe(true);
  },
);

it('serializes large images, HEIC and formats with unknown dimensions even at Ultra', async () => {
  const { transformPhoto, fullCrop } = await import('../src/photos');
  for (const sources of [
    Array.from({ length: 4 }, () => png(5000, 4000)),
    Array.from({ length: 4 }, () => new Blob(['heic'], { type: 'image/heic' })),
    Array.from({ length: 4 }, () => new Blob(['unknown dimensions'], { type: 'image/jpeg' })),
  ]) {
    maximum = 0;
    await Promise.all(
      sources.map((source) => transformPhoto(source, 0, fullCrop, 2560, { concurrency: 4 })),
    );
    expect(maximum).toBe(1);
    expect(active).toBe(0);
  }
});

it('coalesces identical work and keeps crop, rotation and export quality in the cache key', async () => {
  const { transformPhoto, fullCrop } = await import('../src/photos');
  const source = png(1000, 1400);
  const first = await Promise.all(
    [1, 2].map(() => transformPhoto(source, 0, fullCrop, 2560, { concurrency: 4 })),
  );
  expect(first[0]).toBe(first[1]);
  expect(await transformPhoto(source)).toBe(first[0]);
  expect(encodings).toHaveLength(1);
  await transformPhoto(source, 90, { ...fullCrop, left: 5 });
  expect(encodings[1]).toEqual({ width: 1330, height: 1000, type: 'image/jpeg', quality: 0.92 });
  await transformPhoto(source, 0, fullCrop, 480);
  expect(encodings[2]).toEqual({ width: 343, height: 480, type: 'image/jpeg', quality: 0.92 });
});

it('bounds the result cache and rejects oversized headers before decoding', async () => {
  const { transformPhoto } = await import('../src/photos');
  const sources = Array.from({ length: 6 }, () => png());
  for (const source of sources) await transformPhoto(source);
  expect(encodings).toHaveLength(6);
  await transformPhoto(sources[5]);
  expect(encodings).toHaveLength(6);
  await transformPhoto(sources[0]);
  expect(encodings).toHaveLength(7);
  await expect(transformPhoto(png(12000, 6000))).rejects.toThrow('too large to edit');
  expect(encodings).toHaveLength(7);
});
