import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isHeifPhoto } from '../src/heic-format';

describe('HEIC detection', () => {
  it('recognizes MIME types, iPhone filenames and HEVC compatibility brands', async () => {
    expect(await isHeifPhoto(new Blob([], { type: 'image/heif-sequence' }))).toBe(true);
    expect(await isHeifPhoto(new File([], 'IMG_001.HEIC'))).toBe(true);
    const bytes = new Uint8Array(24);
    new DataView(bytes.buffer).setUint32(0, 24);
    bytes.set(new TextEncoder().encode('ftypzzzz'), 4);
    bytes.set(new TextEncoder().encode('heix'), 16);
    expect(await isHeifPhoto(new Blob([bytes]))).toBe(true);
    bytes.set(new TextEncoder().encode('avif'), 8);
    expect(await isHeifPhoto(new Blob([bytes], { type: 'image/avif' }))).toBe(false);
    expect(await isHeifPhoto(new Blob(['not a photo']))).toBe(false);
  });
});

describe('local photo conversion', () => {
  let nativeHeic: boolean;
  let hanging: boolean;
  let current: number;
  let maximum: number;
  let requests: number;
  let instances: number;
  const sources = new Map<string, Blob>();
  class FakeWorker {
    onmessage: ((event: { data: { blob?: Blob; error?: string } }) => void) | null = null;
    onerror: (() => void) | null = null;
    onmessageerror: (() => void) | null = null;
    constructor() {
      instances++;
    }
    terminate() {}
    postMessage(buffer: ArrayBuffer) {
      requests++;
      current++;
      maximum = Math.max(maximum, current);
      if (hanging) return;
      queueMicrotask(() => {
        current--;
        this.onmessage?.({
          data:
            new Uint8Array(buffer)[0] === 0
              ? { error: 'unreadable' }
              : { blob: new Blob([buffer], { type: 'image/png' }) },
        });
      });
    }
  }
  class FakeImage {
    onload?: () => void;
    onerror?: () => void;
    set src(url: string) {
      const source = sources.get(url);
      queueMicrotask(() => {
        if (source?.type === 'image/heic' && !nativeHeic) this.onerror?.();
        else if (source?.type.startsWith('image/')) this.onload?.();
        else this.onerror?.();
      });
    }
  }
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    nativeHeic = hanging = false;
    current = maximum = requests = instances = 0;
    sources.clear();
    vi.stubGlobal('Worker', FakeWorker);
    vi.stubGlobal('Image', FakeImage);
    vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
      if (!(blob instanceof Blob)) throw new Error('Expected a Blob');
      const url = 'blob:' + crypto.randomUUID();
      sources.set(url, blob);
      return url;
    });
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation((url) => {
      sources.delete(url);
    });
  });
  afterEach(async () => {
    await vi.runOnlyPendingTimersAsync();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
  it('uses native decoding first and releases object URLs after success and failure', async () => {
    const { loadImage } = await import('../src/photos');
    await loadImage(new Blob([new Uint8Array([1])], { type: 'image/jpeg' }));
    nativeHeic = true;
    await loadImage(new Blob([new Uint8Array([1])], { type: 'image/heic' }));
    expect(instances).toBe(0);
    nativeHeic = false;
    await loadImage(new Blob([new Uint8Array([1])], { type: 'image/heic' }));
    expect(requests).toBe(1);
    await expect(loadImage(new Blob(['broken']))).rejects.toThrow('export it as JPEG or PNG');
    expect(requests).toBe(1);
    expect(sources.size).toBe(0);
  });
  it('serializes 462 selected photos and retains only the last two conversions', async () => {
    const { decodeHeic } = await import('../src/heic');
    const photos = Array.from(
      { length: 462 },
      (_, index) => new Blob([new Uint8Array([(index % 254) + 1])]),
    );
    const results = await Promise.all(photos.map(decodeHeic));
    expect(results).toHaveLength(462);
    expect(maximum).toBe(1);
    expect(instances).toBe(1);
    expect(requests).toBe(462);
    await decodeHeic(photos[461]);
    expect(requests).toBe(462);
    await decodeHeic(photos[0]);
    expect(requests).toBe(463);
  });
  it('reports corrupt HEIC files and continues with later photos', async () => {
    const { decodeHeic } = await import('../src/heic');
    const bad = decodeHeic(new Blob([new Uint8Array([0])]));
    const good = decodeHeic(new Blob([new Uint8Array([1])]));
    await expect(bad).rejects.toThrow('Export it as JPEG from Photos');
    expect((await good).type).toBe('image/png');
    expect(instances).toBe(2);
  });
  it('restarts after a decode timeout without blocking the next photo', async () => {
    const { decodeHeic } = await import('../src/heic');
    hanging = true;
    const timedOut = expect(decodeHeic(new Blob([new Uint8Array([1])]))).rejects.toThrow(
      'took too long',
    );
    await vi.advanceTimersByTimeAsync(60_000);
    await timedOut;
    hanging = false;
    expect((await decodeHeic(new Blob([new Uint8Array([2])]))).type).toBe('image/png');
    expect(instances).toBe(2);
  });
});
