import { db, type CabinetDB, setting, setSetting, saveCard, friendlyError } from './db';
import { identify, readIdentificationOptions } from './ai';
import {
  aiLeaseMs,
  normalizeIdentificationOptions,
  type IdentificationOptions,
} from './ai-options';
import { auth } from './firebase';
import { plainCard, sameCard, title, type Card, type Suggestions } from './model';

export const batchKey = 'aiBatch';
export const reviewPrefix = 'aiBatchReview:';
export type BatchFailure = { cardId: string; name: string; error: string };
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
  ) => Promise<Suggestions>;
  identificationOptions?: IdentificationOptions;
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

async function photoMatchingLastStart(database: CabinetDB, now: () => number) {
  const matching = await setting<{
    processing?: string[] | null;
    lastAttemptAt?: number;
    notBefore?: number;
  } | null>('aiPhotoMatching', null, database);
  return Math.max(
    await setting<number>('aiPhotoMatchingLastAttemptAt', 0, database),
    matching?.lastAttemptAt || 0,
    (matching?.notBefore || 0) - 15000,
    matching?.processing?.length ? now() + aiLeaseMs - 15000 : 0,
  );
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
    const batch: IdentificationBatch = {
      version: 1,
      id: crypto.randomUUID(),
      cardIds: ids,
      position: 0,
      processing: null,
      status: 'paused',
      lastStart: Math.max(
        previous?.lastStart || 0,
        await photoMatchingLastStart(database, options.now || Date.now),
      ),
      failures: [],
      error: '',
      identificationOptions,
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
    const saved = await setting<IdentificationBatch | null>(batchKey, null, database);
    if (!saved || saved.id !== batchId)
      throw new Error('The saved batch changed. Reopen it before continuing.');
    const identificationOptions = normalizeIdentificationOptions(saved.identificationOptions);
    let batch: IdentificationBatch = { ...saved, identificationOptions };
    const save = async () =>
      database.transaction('rw', database.cards, database.settings, async () => {
        batch = await scrubBatch(batch, database);
        await setSetting(batchKey, batch, database);
      });
    // A stored in-flight request has an unknown outcome after a reload. Never send it again.
    if (batch.processing) {
      const card = await database.cards.get(batch.processing);
      batch.failures.push({
        cardId: batch.processing,
        name: card && !unavailableCard(card) ? title(card) : 'Unavailable card',
        error:
          'Interrupted scan. Its outcome is unknown and it may have been billed. It was not retried.',
      });
      batch.position++;
      batch.processing = null;
      // Wait out the full server lease after recovery because the old request's send time is unknown.
      batch.lastStart = now() + aiLeaseMs - 15000;
      batch.status = 'paused';
      await save();
    }
    if (batch.position >= batch.cardIds.length) {
      batch.status = 'complete';
      batch.error = '';
      await save();
      return batch;
    }
    await (options.ready || ready)();
    const available = await checkCards(batch.cardIds.slice(batch.position), database, true);
    await checkBatchAllowance(available, database);
    batch.lastStart = Math.max(batch.lastStart, await photoMatchingLastStart(database, now));
    batch.status = 'running';
    batch.error = '';
    await save();
    try {
      while (batch.position < batch.cardIds.length && !options.signal?.aborted) {
        const delay = Math.max(0, batch.lastStart + 15000 - now());
        if (delay) {
          options.onActivity?.({ phase: 'waiting', until: batch.lastStart + 15000 });
          await (options.wait || wait)(delay, options.signal);
        }
        if (options.signal?.aborted) break;
        const id = batch.cardIds[batch.position];
        const local = await database.cards.get(id);
        if (unavailableCard(local)) {
          batch.failures.push({
            cardId: id,
            name: 'Unavailable card',
            error: 'This card was removed before its scan.',
          });
          batch.position++;
          continue;
        }
        if (!local) continue;
        const card = plainCard(local);
        batch.processing = id;
        batch.lastStart = now();
        await save();
        options.onActivity?.({ phase: 'identifying' });
        let result: Suggestions;
        try {
          result = await identifyCard(card, identificationOptions);
        } catch (error) {
          const message = friendlyError(error);
          batch.failures.push({ cardId: id, name: title(card), error: message });
          batch.position++;
          batch.processing = null;
          batch.lastStart = now();
          batch.error =
            message + ' The batch stopped. This card will not be retried automatically.';
          break;
        }
        const next: IdentificationBatch = {
          ...batch,
          position: batch.position + 1,
          processing: null,
          lastStart: now(),
        };
        // A result and the next position commit together, so reload cannot lose a completed result.
        await database.transaction('rw', database.cards, database.settings, async () => {
          const current = await database.cards.get(id);
          const key = reviewPrefix + batch!.id + ':' + id;
          if (unavailableCard(current)) {
            await database.settings.delete(key);
            next.failures.push({
              cardId: id,
              name: 'Unavailable card',
              error: 'This card was removed during identification. Its suggestions were discarded.',
            });
          } else {
            await setSetting(
              key,
              { batchId: batch!.id, card, result, identificationOptions } satisfies BatchReview,
              database,
            );
          }
          batch = await scrubBatch(next, database);
          await setSetting(batchKey, batch, database);
        });
      }
      batch.status = batch.position >= batch.cardIds.length ? 'complete' : 'paused';
      await save();
      return batch;
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
