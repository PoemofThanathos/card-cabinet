import { db, type CabinetDB, setting, setSetting, saveCard, friendlyError } from './db';
import { identify, readIdentificationOptions } from './ai';
import {
  aiLeaseMs,
  normalizeIdentificationOptions,
  type IdentificationOptions,
} from './ai-options';
import { auth } from './firebase';
import { plainCard, sameCard, title, type Card, type Suggestions } from './model';
import { normalizeProcessingSpeed, speedProfiles, type ProcessingSpeed } from './processing-speed';

export const batchKey = 'aiBatch';
export const reviewPrefix = 'aiBatchReview:';
export const aiRecoveryNotBeforeKey = 'aiRecoveryNotBefore';
export type BatchFailure = { cardId: string; name: string; error: string };
export type BatchRequest = { cardId: string; index: number; startedAt: number };
export type IdentificationBatch = {
  version: 1;
  id: string;
  cardIds: string[];
  position: number;
  processing: string | null;
  status: 'paused' | 'running' | 'complete';
  lastStart: number;
  failures: BatchFailure[];
  error: string;
  identificationOptions?: IdentificationOptions;
  speed?: ProcessingSpeed;
  nextPosition?: number;
  inFlight?: BatchRequest[];
  notBefore?: number;
};
export type BatchReview = {
  batchId: string;
  card: Card;
  result: Suggestions;
  identificationOptions?: IdentificationOptions;
};
export type BatchActivity = { phase: 'waiting' | 'identifying' | 'idle'; until?: number };
type Lock = <T>(action: () => Promise<T>) => Promise<T>;
type Options = {
  database?: CabinetDB;
  lock?: Lock;
  identifyCard?: (
    card: Card,
    identificationOptions?: IdentificationOptions,
    speed?: ProcessingSpeed,
  ) => Promise<Suggestions>;
  identificationOptions?: IdentificationOptions;
  speed?: ProcessingSpeed;
  ready?: () => Promise<void>;
  signal?: AbortSignal;
  now?: () => number;
  wait?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  onActivity?: (activity: BatchActivity) => void;
};

export async function withBatchLock<T>(action: () => Promise<T>): Promise<T> {
  if (!globalThis.navigator?.locks)
    throw new Error(
      'This browser cannot safely run a batch. Use a current Safari, Chrome or Edge, or identify cards individually.',
    );
  return navigator.locks.request('card-cabinet-ai-batch', { ifAvailable: true }, async (lock) => {
    if (!lock) throw new Error('Another tab is running this batch. Pause it there first.');
    return action();
  });
}

async function ready() {
  if (!navigator.onLine) throw new Error('Connect to the internet before starting identification.');
  if (!(await setting('aiEnabled', false)))
    throw new Error('Enable identification in Settings first.');
  if (!auth?.currentUser) throw new Error('Sign in before starting identification.');
  if (!import.meta.env.VITE_WORKER_URL?.startsWith('https://'))
    throw new Error('Configure your HTTPS Worker URL first.');
}

export async function checkBatchAllowance(count: number, database = db) {
  if (await setting('aiUnlimited', false, database)) return;
  const day = new Date().toISOString().slice(0, 10);
  const usage = await setting('aiUsage', { day, count: 0 }, database);
  const limit = Math.min(5, Math.max(1, await setting('aiLimit', 3, database)));
  const remaining = Math.max(0, limit - (usage.day === day ? usage.count : 0));
  if (count > remaining)
    throw new Error(
      `This batch needs ${count} attempts, but this device has ${remaining} left today. Enable Unlimited attempts in Settings or choose fewer cards.`,
    );
}

const unavailableCard = (card: Card | undefined) =>
  !card || card.status === 'deleted' || card.status === 'purged';

async function scrubBatch(
  batch: IdentificationBatch,
  database: CabinetDB,
): Promise<IdentificationBatch> {
  const cards = await database.cards.bulkGet(batch.failures.map((failure) => failure.cardId));
  let removed = false;
  const failures = batch.failures.map((failure, index) => {
    if (cards[index]?.status !== 'purged') return failure;
    removed = true;
    return {
      cardId: failure.cardId,
      name: 'Permanently deleted card',
      error: 'This card was permanently deleted. Its identification data was removed.',
    };
  });
  return {
    ...batch,
    failures,
    error:
      removed && batch.error
        ? 'A card was permanently deleted. Its identification data was removed.'
        : batch.error,
  };
}

async function checkCards(ids: string[], database: CabinetDB, skipUnavailable = false) {
  let available = 0;
  for (const id of ids) {
    const card = await database.cards.get(id);
    if (unavailableCard(card)) {
      if (skipUnavailable) continue;
      throw new Error(
        'A queued card is no longer available. Start a new batch with your current selection.',
      );
    }
    if (!card) continue;
    available++;
    for (const side of ['front', 'back'] as const) {
      const hash = card.photos[side];
      if (!hash || !(await database.photos.get(hash)))
        throw new Error(`${title(card)} needs its ${side} photo on this device.`);
    }
  }
  return available;
}

async function photoMatchingTiming(database: CabinetDB, now: () => number) {
  const matching = await setting<{
    processing?: string[] | null;
    inFlight?: unknown[];
    lastAttemptAt?: number;
    notBefore?: number;
  } | null>('aiPhotoMatching', null, database);
  const lastStart = Math.max(
    await setting<number>('aiPhotoMatchingLastAttemptAt', 0, database),
    matching?.lastAttemptAt || 0,
  );
  return {
    lastStart,
    notBefore: Math.max(
      matching?.notBefore || 0,
      await setting<number>(aiRecoveryNotBeforeKey, 0, database),
      // Older discarded jobs stored a future cooldown in the timestamp itself.
      lastStart > now() ? lastStart + 15000 : 0,
      matching?.inFlight?.length || matching?.processing?.length ? now() + aiLeaseMs : 0,
    ),
  };
}

function normalizeBatch(
  saved: IdentificationBatch,
): IdentificationBatch & {
  nextPosition: number;
  inFlight: BatchRequest[];
  notBefore: number;
  speed: ProcessingSpeed;
} {
  const inFlight = saved.inFlight?.length
    ? saved.inFlight
    : saved.processing
      ? [{ cardId: saved.processing, index: saved.position, startedAt: saved.lastStart }]
      : [];
  return {
    ...saved,
    identificationOptions: normalizeIdentificationOptions(saved.identificationOptions),
    speed: normalizeProcessingSpeed(saved.speed),
    inFlight,
    nextPosition: Math.max(
      saved.nextPosition ?? saved.position,
      ...inFlight.map((request) => request.index + 1),
    ),
    notBefore: saved.notBefore || 0,
    processing: inFlight[0]?.cardId || null,
  };
}

export async function createBatch(cardIds: string[], options: Options = {}) {
  const database = options.database || db;
  return (options.lock || withBatchLock)(async () => {
    const ids = [...new Set(cardIds)];
    if (!ids.length) throw new Error('Choose cards to identify.');
    const identificationOptions = normalizeIdentificationOptions(
      options.identificationOptions ?? (await readIdentificationOptions(database)),
    );
    await (options.ready || ready)();
    await checkBatchAllowance(ids.length, database);
    await checkCards(ids, database);
    const previous = await setting<IdentificationBatch | null>(batchKey, null, database);
    const now = options.now || Date.now;
    const matching = await photoMatchingTiming(database, now);
    const batch: IdentificationBatch = {
      version: 1,
      id: crypto.randomUUID(),
      cardIds: ids,
      position: 0,
      processing: null,
      status: 'paused',
      lastStart: Math.max(previous?.lastStart || 0, matching.lastStart),
      failures: [],
      error: '',
      identificationOptions,
      speed: normalizeProcessingSpeed(options.speed),
      nextPosition: 0,
      inFlight: [],
      notBefore: Math.max(
        previous?.notBefore || 0,
        matching.notBefore,
        (previous?.lastStart || 0) > now() ? previous!.lastStart + 15000 : 0,
        previous?.inFlight?.length || previous?.processing ? now() + aiLeaseMs : 0,
      ),
    };
    await setSetting(batchKey, batch, database);
    return batch;
  });
}

function wait(milliseconds: number, signal?: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    signal?.addEventListener('abort', finish, { once: true });
  });
}

export async function runBatch(batchId: string, options: Options = {}) {
  const database = options.database || db;
  const now = options.now || Date.now;
  const identifyCard = options.identifyCard || identify;
  return (options.lock || withBatchLock)(async () => {
    const read = async () => {
      const saved = await setting<IdentificationBatch | null>(batchKey, null, database);
      if (!saved || saved.id !== batchId)
        throw new Error('The saved batch changed. Reopen it before continuing.');
      return normalizeBatch(saved);
    };
    type Job = Awaited<ReturnType<typeof read>>;
    // Every writer reads the latest job inside the same transaction. Parallel responses
    // and permanent deletion cannot overwrite one another's saved results or failures.
    const update = (change: (job: Job) => Promise<void> | void) =>
      database.transaction('rw', database.cards, database.settings, async () => {
        const job = await read();
        await change(job);
        job.processing = job.inFlight[0]?.cardId || null;
        const clean = normalizeBatch(await scrubBatch(job, database));
        await setSetting(batchKey, clean, database);
        return clean;
      });
    let batch = await read();
    if (batch.inFlight.length) {
      batch = await update(async (job) => {
        for (const request of job.inFlight) {
          const card = await database.cards.get(request.cardId);
          job.failures.push({
            cardId: request.cardId,
            name: card && !unavailableCard(card) ? title(card) : 'Unavailable card',
            error:
              'Interrupted scan. Its outcome is unknown and it may have been billed. It was not retried.',
          });
          job.position++;
        }
        job.inFlight = [];
        job.processing = null;
        job.notBefore = Math.max(job.notBefore, now() + aiLeaseMs);
        job.status = 'paused';
        await setSetting(
          aiRecoveryNotBeforeKey,
          Math.max(job.notBefore, await setting(aiRecoveryNotBeforeKey, 0, database)),
          database,
        );
      });
    }
    const speed = normalizeProcessingSpeed(options.speed ?? batch.speed);
    const profile = speedProfiles[speed];
    const identificationOptions = normalizeIdentificationOptions(batch.identificationOptions);
    if (batch.position >= batch.cardIds.length) {
      return update((job) => {
        job.speed = speed;
        job.status = 'complete';
        job.error = '';
      });
    }
    await (options.ready || ready)();
    const available = await checkCards(batch.cardIds.slice(batch.nextPosition), database, true);
    await checkBatchAllowance(available, database);
    const matching = await photoMatchingTiming(database, now);
    batch = await update((job) => {
      job.speed = speed;
      job.lastStart = Math.max(job.lastStart, matching.lastStart);
      job.notBefore = Math.max(
        job.notBefore,
        matching.notBefore,
        job.lastStart > now() ? job.lastStart + 15000 : 0,
      );
      job.status = 'running';
      job.error = '';
    });
    let stopped = false;
    let fatal: unknown;
    const attempt = async (request: BatchRequest, card: Card) => {
      let result: Suggestions | undefined;
      let failure = '';
      try {
        result = await identifyCard(card, identificationOptions, speed);
      } catch (error) {
        stopped = true;
        failure = friendlyError(error);
      }
      await update(async (job) => {
        const pending = job.inFlight.find((item) => item.index === request.index);
        if (!pending)
          throw new Error('This identification request changed before its result was saved.');
        const current = await database.cards.get(card.id);
        const key = reviewPrefix + batchId + ':' + card.id;
        if (failure) {
          job.failures.push({ cardId: card.id, name: title(card), error: failure });
          job.error =
            failure + ' The batch stopped. Failed cards will not be retried automatically.';
        } else if (unavailableCard(current)) {
          await database.settings.delete(key);
          job.failures.push({
            cardId: card.id,
            name: 'Unavailable card',
            error: 'This card was removed during identification. Its suggestions were discarded.',
          });
        } else {
          await setSetting(
            key,
            { batchId, card, result: result!, identificationOptions } satisfies BatchReview,
            database,
          );
        }
        job.position++;
        job.inFlight = job.inFlight.filter((item) => item.index !== request.index);
        job.lastStart = Math.max(job.lastStart, now());
      });
    };
    try {
      while (batch.nextPosition < batch.cardIds.length && !options.signal?.aborted && !stopped) {
        const until = Math.max(batch.lastStart + profile.delayMs, batch.notBefore);
        const delay = Math.max(0, until - now());
        if (delay) {
          options.onActivity?.({ phase: 'waiting', until });
          await (options.wait || wait)(delay, options.signal);
        }
        if (options.signal?.aborted) break;
        const wave: Promise<void>[] = [];
        for (
          let slot = 0;
          slot < profile.concurrency && !options.signal?.aborted && !stopped;
          slot++
        ) {
          let selected: { request: BatchRequest; card: Card } | undefined;
          try {
            batch = await update(async (job) => {
              if (stopped || options.signal?.aborted || job.nextPosition >= job.cardIds.length)
                return;
              const index = job.nextPosition;
              const card = await database.cards.get(job.cardIds[index]);
              if (stopped || options.signal?.aborted) return;
              job.nextPosition++;
              if (unavailableCard(card)) {
                job.failures.push({
                  cardId: job.cardIds[index],
                  name: 'Unavailable card',
                  error: 'This card was removed before its scan.',
                });
                job.position++;
                return;
              }
              const request: BatchRequest = { cardId: card!.id, index, startedAt: now() };
              job.inFlight.push(request);
              job.lastStart = Math.max(job.lastStart, request.startedAt);
              selected = { request, card: plainCard(card!) };
            });
          } catch (error) {
            stopped = true;
            fatal = error;
            break;
          }
          if (selected) {
            if (stopped || options.signal?.aborted) {
              const unstarted = selected;
              try {
                batch = await update((job) => {
                  job.inFlight = job.inFlight.filter(
                    (item) => item.index !== unstarted.request.index,
                  );
                  job.nextPosition = unstarted.request.index;
                });
              } catch (error) {
                fatal = error;
              }
              break;
            }
            // Attach a rejection handler immediately while other requests are checkpointed.
            const active = selected;
            wave.push(
              attempt(active.request, active.card).catch((error) => {
                stopped = true;
                fatal = error;
              }),
            );
            options.onActivity?.({ phase: 'identifying' });
          }
        }
        // Pause and failure stop launches, but every already-sent result is still stored.
        await Promise.all(wave);
        if (fatal) throw fatal;
        batch = await read();
      }
      return await update((job) => {
        job.status = job.position >= job.cardIds.length ? 'complete' : 'paused';
      });
    } finally {
      options.onActivity?.({ phase: 'idle' });
    }
  });
}

export async function applyBatchReview(
  key: string,
  values: Partial<Card['fields']>,
  database = db,
) {
  let purged = false;
  await database.transaction(
    'rw',
    database.settings,
    database.cards,
    database.photos,
    database.queue,
    async () => {
      const review = await setting<BatchReview | null>(key, null, database);
      if (!review) throw new Error('These suggestions were already reviewed.');
      const current = await database.cards.get(review.card.id);
      if (current?.status === 'purged' || review.card.status === 'purged') {
        await database.settings.delete(key);
        purged = true;
        return;
      }
      if (!current || current.status === 'deleted' || !sameCard(plainCard(current), review.card))
        throw new Error(
          'This card changed after identification. Your current card and saved suggestions are kept. Review the current card before identifying it again.',
        );
      const allowed = Object.fromEntries(
        review.result.suggestions
          .filter((s) => !s.uncertain && s.value && values[s.field] === s.value)
          .map((s) => [s.field, s.value]),
      );
      await saveCard(
        { ...review.card, fields: { ...review.card.fields, ...allowed } },
        [],
        database,
        review.card,
      );
      await database.settings.delete(key);
    },
  );
  if (purged)
    throw new Error('This card was permanently deleted. Its saved suggestions were removed.');
}
