const unreadable =
  'This HEIC/HEIF photo could not be read. It may be damaged or use an unsupported format. Export it as JPEG from Photos and select that file.';
const unavailable =
  'HEIC conversion could not start. Reopen the app while online to finish downloading its decoder, then try again. You can also export the photo as JPEG from Photos.';
let worker: Worker | undefined;
let idleTimer: ReturnType<typeof setTimeout> | undefined;
let queue: Promise<unknown> = Promise.resolve();
// Retain only the current pair, even when the caller keeps hundreds of Files selected.
const recent: { source: Blob; converted: Blob }[] = [];
type WorkerResult = {
  blob?: Blob;
  error?: string;
  pixels?: Uint8ClampedArray;
  width?: number;
  height?: number;
};

async function encodePixels(data: WorkerResult): Promise<Blob> {
  const { width, height, pixels } = data;
  if (
    !width ||
    !height ||
    !pixels ||
    width * height > 60_000_000 ||
    pixels.length !== width * height * 4
  )
    throw new Error(unreadable);
  const canvas = document.createElement('canvas');
  const resized = document.createElement('canvas');
  try {
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error(unavailable);
    context.putImageData(
      new ImageData(pixels as Uint8ClampedArray<ArrayBuffer>, width, height),
      0,
      0,
    );
    const scale = Math.min(1, 3200 / Math.max(width, height));
    resized.width = Math.round(width * scale);
    resized.height = Math.round(height * scale);
    const output = resized.getContext('2d');
    if (!output) throw new Error(unavailable);
    output.drawImage(canvas, 0, 0, resized.width, resized.height);
    return await new Promise<Blob>((resolve, reject) =>
      resized.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error(unavailable))),
        'image/png',
      ),
    );
  } finally {
    canvas.width = canvas.height = resized.width = resized.height = 1;
  }
}

function stopWorker() {
  worker?.terminate();
  worker = undefined;
  clearTimeout(idleTimer);
}

async function convert(source: Blob): Promise<Blob> {
  const cached = recent.find((item) => item.source === source);
  if (cached) return cached.converted;
  if (source.size > 40 * 1024 * 1024)
    throw new Error('This image is larger than 40 MB. Choose a smaller image.');
  clearTimeout(idleTimer);
  let converted: Blob;
  try {
    worker ??= new Worker(new URL('./heic-worker.ts', import.meta.url), { type: 'module' });
    const activeWorker = worker;
    const bytes = await source.arrayBuffer();
    converted = await new Promise<Blob>((resolve, reject) => {
      const timeout = setTimeout(() => {
        stopWorker();
        reject(
          new Error(
            'HEIC conversion took too long. Try this photo again, or export it as JPEG from Photos.',
          ),
        );
      }, 60_000);
      const finish = () => {
        clearTimeout(timeout);
        activeWorker.onmessage = null;
        activeWorker.onerror = null;
        activeWorker.onmessageerror = null;
      };
      activeWorker.onmessage = ({ data }: MessageEvent<WorkerResult>) => {
        finish();
        if (data.blob instanceof Blob) resolve(data.blob);
        else if (data.pixels) encodePixels(data).then(resolve, reject);
        else {
          stopWorker();
          reject(
            new Error(
              data.error === 'too-large'
                ? 'This image is too large to edit safely on a phone. Choose a smaller image.'
                : data.error === 'unavailable'
                  ? unavailable
                  : unreadable,
            ),
          );
        }
      };
      activeWorker.onerror = activeWorker.onmessageerror = () => {
        finish();
        stopWorker();
        reject(new Error(unavailable));
      };
      activeWorker.postMessage(bytes, [bytes]);
    });
  } catch (error) {
    stopWorker();
    if (error instanceof Error && /^This |^HEIC /.test(error.message)) throw error;
    throw new Error(unavailable);
  } finally {
    if (worker) idleTimer = setTimeout(stopWorker, 30_000);
  }
  recent.push({ source, converted });
  if (recent.length > 2) recent.shift();
  return converted;
}

/** No network upload. A single worker decodes one source at a time. */
export function decodeHeic(source: Blob): Promise<Blob> {
  const next = queue.then(() => convert(source));
  queue = next.catch(() => undefined);
  return next;
}
