import decoderUrl from 'libheif-js/libheif-wasm/libheif-bundle.mjs?url';

type Pixels = { data: Uint8ClampedArray; width: number; height: number };
type HeifImage = {
  get_width(): number;
  get_height(): number;
  is_primary(): boolean;
  display(target: Pixels, done: (image: Pixels | null) => void): void;
  free(): void;
};
type HeifDecoder = { decode(bytes: Uint8Array): HeifImage[] };
type HeifModule = { HeifDecoder: new () => HeifDecoder };
let decoder: Promise<HeifDecoder> | undefined;

function getDecoder() {
  // Keep the LGPL library as a separate, replaceable asset. It includes its WASM binary.
  decoder ??= import(/* @vite-ignore */ decoderUrl)
    .then((module) => (module.default as () => Promise<HeifModule>)())
    .then((module) => new module.HeifDecoder())
    .catch(() => {
      throw new Error('unavailable');
    });
  return decoder;
}

const worker = globalThis as unknown as {
  onmessage: (event: MessageEvent<ArrayBuffer>) => void;
  postMessage(message: unknown, transfer?: Transferable[]): void;
};

worker.onmessage = async ({ data }) => {
  let images: HeifImage[] = [];
  let canvas: OffscreenCanvas | undefined;
  let resized: OffscreenCanvas | undefined;
  try {
    images = (await getDecoder()).decode(new Uint8Array(data));
    const image = images.find((candidate) => candidate.is_primary()) ?? images[0];
    if (!image) throw new Error('unreadable');
    const width = image.get_width(),
      height = image.get_height();
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0)
      throw new Error('unreadable');
    if (width * height > 60_000_000) throw new Error('too-large');
    const pixels = await new Promise<Pixels>((resolve, reject) => {
      image.display(
        { data: new Uint8ClampedArray(width * height * 4), width, height },
        (decoded) => {
          if (decoded) resolve(decoded);
          else reject(new Error('unreadable'));
        },
      );
    });
    // Some WebKit versions support workers/WASM but not worker canvases.
    if (typeof OffscreenCanvas === 'undefined') {
      worker.postMessage({ pixels: pixels.data, width, height }, [pixels.data.buffer]);
      return;
    }
    canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d');
    if (!context) {
      worker.postMessage({ pixels: pixels.data, width, height }, [pixels.data.buffer]);
      return;
    }
    context.putImageData(
      new ImageData(pixels.data as Uint8ClampedArray<ArrayBuffer>, width, height),
      0,
      0,
    );
    const scale = Math.min(1, 3200 / Math.max(width, height));
    resized = new OffscreenCanvas(Math.round(width * scale), Math.round(height * scale));
    const output = resized.getContext('2d');
    if (!output) throw new Error('unavailable');
    output.drawImage(canvas, 0, 0, resized.width, resized.height);
    // PNG avoids another lossy encoding before the existing crop/JPEG export.
    const blob = await resized.convertToBlob({ type: 'image/png' });
    worker.postMessage({ blob });
  } catch (error) {
    worker.postMessage({ error: error instanceof Error ? error.message : 'unreadable' });
  } finally {
    for (const image of images) image.free();
    if (canvas) canvas.width = canvas.height = 1;
    if (resized) resized.width = resized.height = 1;
  }
};
