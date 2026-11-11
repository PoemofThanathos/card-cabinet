import { analyzePhotos, assertIdentificationReady } from './ai';
import {
  aiLeaseMs,
  normalizeIdentificationOptions,
  type IdentificationOptions,
} from './ai-options';
import {
  aiRecoveryNotBeforeKey,
  batchKey,
  checkBatchAllowance,
  withBatchLock,
  type IdentificationBatch,
} from './batch';
import { fileKey, type FileReference } from './bulk-entry';
import { db, type CabinetDB, friendlyError, setting, setSetting } from './db';
import {
  photoAnalysisResultSchema,
  type PhotoAnalysis,
  type PhotoAnalysisResult,
} from './photo-analysis';
import { normalizeProcessingSpeed, speedProfiles, type ProcessingSpeed } from './processing-speed';

export const photoMatchingKey = 'aiPhotoMatching';
export const photoMatchingLastAttemptKey = 'aiPhotoMatchingLastAttemptAt';
export type PhotoMatchingOutcome = { analysis?: PhotoAnalysis; error?: string };
export type PhotoMatchingRequest = { keys: string[]; index: number; startedAt: number };
export type PhotoMatchingJob = {
  version: 1;
  id: string;
  files: FileReference[];
  identificationOptions: IdentificationOptions;
  cursor: number;
  processing: string[] | null;
  status: 'paused' | 'running' | 'complete';
  lastAttemptAt: number;
  notBefore: number;
  results: Record<string, PhotoMatchingOutcome>;
  reviewPairs?: [FileReference, FileReference][];
  error: string;
  speed?: ProcessingSpeed;
  nextCursor?: number;
  inFlight?: PhotoMatchingRequest[];
};
export type PhotoMatchingActivity = {
  phase: 'analyzing' | 'waiting' | 'paused' | 'complete';
  until?: number;
};
type Lock = <T>(action: () => Promise<T>) => Promise<T>;
export type PhotoMatchingOptions = {
  database?: CabinetDB;
  lock?: Lock;
  analyze?: (
    blobs: Blob[],
    options: IdentificationOptions,
    speed?: ProcessingSpeed,
  ) => Promise<PhotoAnalysisResult>;
  speed?: ProcessingSpeed;
  ready?: () => Promise<void>;
  signal?: AbortSignal;
  now?: () => number;
  wait?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  onProgress?: (job: PhotoMatchingJob, activity?: PhotoMatchingActivity) => void;
};

export function getPhotoMatchingJob(database = db) {
  return setting<PhotoMatchingJob | null>(photoMatchingKey, null, database);
}

function normalizeJob(saved: PhotoMatchingJob): PhotoMatchingJob & {
  nextCursor: number;
  inFlight: PhotoMatchingRequest[];
  speed: ProcessingSpeed;
} {
  const inFlight = saved.inFlight?.length
    ? saved.inFlight
    : saved.processing?.length
      ? [{ keys: saved.processing, index: saved.cursor, startedAt: saved.lastAttemptAt }]
      : [];
  return {
    ...saved,
    identificationOptions: normalizeIdentificationOptions(saved.identificationOptions),
    speed: normalizeProcessingSpeed(saved.speed),
    inFlight,
    nextCursor: Math.max(
      saved.nextCursor ?? saved.cursor,
      ...inFlight.map((request) => request.index + request.keys.length),
    ),
    processing: inFlight.length ? inFlight.flatMap((request) => request.keys) : null,
    notBefore: saved.notBefore || 0,
  };
}

export function analysisPendingFiles(job: PhotoMatchingJob): FileReference[] {
  return job.files.slice(normalizeJob(job).nextCursor);
}

async function batchTiming(database: CabinetDB, now: () => number) {
  const batch = await setting<IdentificationBatch | null>(batchKey, null, database);
  const lastAttemptAt = Math.max(
    await setting(photoMatchingLastAttemptKey, 0, database),
    batch?.lastStart || 0,
  );
  return {
    lastAttemptAt,
    notBefore: Math.max(
      batch?.notBefore || 0,
      await setting(aiRecoveryNotBeforeKey, 0, database),
      lastAttemptAt > now() ? lastAttemptAt + 15000 : 0,
      batch?.inFlight?.length || batch?.processing ? now() + aiLeaseMs : 0,
    ),
  };
}

async function ready(options: PhotoMatchingOptions, database: CabinetDB) {
  if (options.ready) return options.ready();
  if (globalThis.navigator?.onLine === false)
    throw new Error('Connect to the internet before analyzing photos.');
  await assertIdentificationReady(database);
}

function validateReferences(files: FileReference[]) {
  if (!files.length) throw new Error('Choose photos to analyze.');
  const keys = new Set<string>();
  for (const source of files) {
    if (
      !source.name ||
      !Number.isFinite(source.size) ||
      source.size < 0 ||
      !Number.isFinite(source.lastModified)
    )
      throw new Error('A selected photo has invalid file details. Select the files again.');
    const key = fileKey(source);
    if (keys.has(key))
      throw new Error(
        `Two photos have the same filename, size and date: ${source.name}. Rename one file before continuing.`,
      );
    keys.add(key);
  }
}

export async function createPhotoMatchingJob(
  files: FileReference[],
  identificationOptions: IdentificationOptions,
  options: PhotoMatchingOptions = {},
) {
  const database = options.database || db;
  const now = options.now || Date.now;
  return (options.lock || withBatchLock)(async () => {
    if (await getPhotoMatchingJob(database))
      throw new Error(
        'A photo analysis is already saved. Resume or explicitly discard it before starting another.',
      );
    validateReferences(files);
    await ready(options, database);
    await checkBatchAllowance(Math.ceil(files.length / 2), database);
    const timing = await batchTiming(database, now);
    const job: PhotoMatchingJob = {
      version: 1,
      id: crypto.randomUUID(),
      files: structuredClone(files),
      identificationOptions: normalizeIdentificationOptions(identificationOptions),
      cursor: 0,
      processing: null,
      status: 'paused',
      lastAttemptAt: timing.lastAttemptAt,
      notBefore: timing.notBefore,
      results: {},
      error: '',
      speed: normalizeProcessingSpeed(options.speed),
      nextCursor: 0,
      inFlight: [],
    };
    await setSetting(photoMatchingKey, job, database);
    return job;
  });
}

function requireFiles(sources: FileReference[], files: Map<string, File>) {
  return sources.map((source) => {
    const selected = files.get(fileKey(source));
    if (!selected || fileKey(selected) !== fileKey(source))
      throw new Error(
        `Select the original photo again: ${source.name}. Completed analysis is saved.`,
      );
    return selected;
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

export async function runPhotoMatchingJob(
  id: string,
  files: Map<string, File>,
  options: PhotoMatchingOptions = {},
) {
  const database = options.database || db;
  const now = options.now || Date.now;
  const analyze = options.analyze || analyzePhotos;
  return (options.lock || withBatchLock)(async () => {
    const read = async () => {
      const saved = await getPhotoMatchingJob(database);
      if (!saved || saved.id !== id)
        throw new Error('The saved photo analysis changed. Reopen it before continuing.');
      return normalizeJob(saved);
    };
    type Job = Awaited<ReturnType<typeof read>>;
    const update = (change: (job: Job) => Promise<void> | void) =>
      database.transaction('rw', database.settings, async () => {
        const current = await read();
        await change(current);
        current.processing = current.inFlight.length
          ? current.inFlight.flatMap((request) => request.keys)
          : null;
        await setSetting(photoMatchingKey, current, database);
        await setSetting(
          photoMatchingLastAttemptKey,
          Math.max(current.lastAttemptAt, await setting(photoMatchingLastAttemptKey, 0, database)),
          database,
        );
        return current;
      });
    let job = await read();
    const progress = (current: PhotoMatchingJob, activity: PhotoMatchingActivity) =>
      options.onProgress?.(structuredClone(current), activity);
    if (job.inFlight.length) {
      job = await update(async (current) => {
        for (const request of current.inFlight) {
          for (const key of request.keys)
            current.results[key] = {
              error:
                'Interrupted request. Its outcome is unknown and it may have used API credit. This photo was not retried.',
            };
          current.cursor += request.keys.length;
        }
        current.inFlight = [];
        current.processing = null;
        current.notBefore = Math.max(current.notBefore, now() + aiLeaseMs);
        current.status = 'paused';
        await setSetting(
          aiRecoveryNotBeforeKey,
          Math.max(current.notBefore, await setting(aiRecoveryNotBeforeKey, 0, database)),
          database,
        );
      });
    }
    const speed = normalizeProcessingSpeed(options.speed ?? job.speed);
    const profile = speedProfiles[speed];
    const identificationOptions = normalizeIdentificationOptions(job.identificationOptions);
    if (job.cursor >= job.files.length) {
      job = await update((current) => {
        current.speed = speed;
        current.status = 'complete';
        current.error = '';
      });
      progress(job, { phase: 'complete' });
      return job;
    }
    // Missing originals do not consume an attempt or skip photos.
    requireFiles(job.files.slice(job.nextCursor), files);
    await ready(options, database);
    await checkBatchAllowance(Math.ceil((job.files.length - job.nextCursor) / 2), database);
    const timing = await batchTiming(database, now);
    job = await update((current) => {
      current.speed = speed;
      current.lastAttemptAt = Math.max(current.lastAttemptAt, timing.lastAttemptAt);
      current.notBefore = Math.max(current.notBefore, timing.notBefore);
      current.status = 'running';
      current.error = '';
    });
    let stopped = false;
    let fatal: unknown;
    const attempt = async (request: PhotoMatchingRequest, blobs: Blob[]) => {
      let result: PhotoAnalysisResult | undefined;
      let failure = '';
      try {
        result = photoAnalysisResultSchema.parse(
          await analyze(blobs, identificationOptions, speed),
        );
        if (result.photos.length !== request.keys.length)
          throw new Error(
            'Photo analysis returned the wrong number of descriptions. No automatic retry was sent.',
          );
      } catch (error) {
        stopped = true;
        failure = friendlyError(error);
      }
      const saved = await update((current) => {
        if (!current.inFlight.some((item) => item.index === request.index))
          throw new Error('This photo request changed before its result was saved.');
        for (let index = 0; index < request.keys.length; index++) {
          current.results[request.keys[index]] = failure
            ? { error: failure }
            : { analysis: result!.photos[index] };
        }
        current.cursor += request.keys.length;
        current.inFlight = current.inFlight.filter((item) => item.index !== request.index);
        current.lastAttemptAt = Math.max(current.lastAttemptAt, now());
        if (failure)
          current.error =
            failure + ' Analysis stopped. Failed photos will not be retried automatically.';
      });
      progress(saved, { phase: stopped || options.signal?.aborted ? 'paused' : 'analyzing' });
    };
    try {
      while (job.nextCursor < job.files.length && !options.signal?.aborted && !stopped) {
        const until = Math.max(job.lastAttemptAt + profile.delayMs, job.notBefore);
        const delay = Math.max(0, until - now());
        if (delay) {
          progress(job, { phase: 'waiting', until });
          await (options.wait || wait)(delay, options.signal);
        }
        if (options.signal?.aborted) break;
        const wave: Promise<void>[] = [];
        for (
          let slot = 0;
          slot < profile.concurrency && !options.signal?.aborted && !stopped;
          slot++
        ) {
          let request: PhotoMatchingRequest | undefined;
          let blobs: File[] = [];
          try {
            job = await update((current) => {
              if (stopped || options.signal?.aborted || current.nextCursor >= current.files.length)
                return;
              const index = current.nextCursor;
              const sources = current.files.slice(index, index + 2);
              blobs = requireFiles(sources, files);
              request = { keys: sources.map(fileKey), index, startedAt: now() };
              current.nextCursor += sources.length;
              current.inFlight.push(request);
              current.lastAttemptAt = Math.max(current.lastAttemptAt, request.startedAt);
            });
          } catch (error) {
            stopped = true;
            fatal = error;
            break;
          }
          if (request) {
            if (stopped || options.signal?.aborted) {
              const unstarted = request;
              try {
                job = await update((current) => {
                  current.inFlight = current.inFlight.filter(
                    (item) => item.index !== unstarted.index,
                  );
                  current.nextCursor = unstarted.index;
                });
              } catch (error) {
                fatal = error;
              }
              break;
            }
            wave.push(
              attempt(request, blobs).catch((error) => {
                stopped = true;
                fatal = error;
              }),
            );
            progress(job, { phase: 'analyzing' });
          }
        }
        await Promise.all(wave);
        if (fatal) throw fatal;
        job = await read();
      }
      job = await update((current) => {
        current.status = current.cursor >= current.files.length ? 'complete' : 'paused';
      });
      progress(job, { phase: job.status as 'complete' | 'paused' });
      return job;
    } catch (error) {
      // Keep unfinished checkpoints when local result storage fails.
      progress(await read(), { phase: 'paused' });
      throw error;
    }
  });
}

export async function deletePhotoMatchingJob(id: string, options: PhotoMatchingOptions = {}) {
  const database = options.database || db;
  return (options.lock || withBatchLock)(async () => {
    const job = await getPhotoMatchingJob(database);
    if (!job || job.id !== id) throw new Error('The saved photo analysis changed.');
    await database.transaction('rw', database.settings, async () => {
      const notBefore = Math.max(
        job.notBefore || 0,
        await setting(aiRecoveryNotBeforeKey, 0, database),
        job.inFlight?.length || job.processing?.length
          ? (options.now || Date.now)() + aiLeaseMs
          : 0,
      );
      await setSetting(aiRecoveryNotBeforeKey, notBefore, database);
      await database.settings.delete(photoMatchingKey);
    });
  });
}

function validateReviewedPairs(job: PhotoMatchingJob, pairs: [FileReference, FileReference][]) {
  if (job.status !== 'complete' || job.processing || job.inFlight?.length)
    throw new Error('Finish photo analysis before accepting pairs.');
  const known = new Set(job.files.map(fileKey));
  const accepted = new Set<string>();
  for (const pair of pairs) {
    if (pair.length !== 2) throw new Error('Each card needs exactly two photos.');
    for (const source of pair) {
      const key = fileKey(source);
      if (!known.has(key) || accepted.has(key))
        throw new Error('Each accepted photo must be known and used only once.');
      accepted.add(key);
    }
  }
  return accepted;
}

export async function savePhotoMatchingReview(
  id: string,
  pairs: [FileReference, FileReference][],
  options: PhotoMatchingOptions = {},
) {
  const database = options.database || db;
  return (options.lock || withBatchLock)(() =>
    database.transaction('rw', database.settings, async () => {
      const job = await getPhotoMatchingJob(database);
      if (!job || job.id !== id) throw new Error('The saved photo analysis changed.');
      validateReviewedPairs(job, pairs);
      const next: PhotoMatchingJob = { ...job, reviewPairs: structuredClone(pairs) };
      await setSetting(photoMatchingKey, next, database);
      return next;
    }),
  );
}

export async function consumePhotoMatchingPairs(
  id: string,
  pairs: [FileReference, FileReference][],
  database = db,
) {
  return database.transaction('rw', database.settings, async () => {
    const job = await getPhotoMatchingJob(database);
    if (!job || job.id !== id) throw new Error('The saved photo analysis changed.');
    const accepted = validateReviewedPairs(job, pairs);
    const remaining = job.files.filter((source) => !accepted.has(fileKey(source)));
    if (!remaining.length) {
      await database.settings.delete(photoMatchingKey);
      return null;
    }
    const results = Object.fromEntries(
      remaining.map((source) => [fileKey(source), job.results[fileKey(source)]]),
    );
    const next: PhotoMatchingJob = {
      ...job,
      files: remaining,
      results,
      cursor: remaining.length,
      nextCursor: remaining.length,
      inFlight: [],
      status: 'complete',
      processing: null,
      ...(job.reviewPairs !== undefined
        ? {
            reviewPairs: job.reviewPairs.filter((pair) =>
              pair.every((source) => !accepted.has(fileKey(source))),
            ),
          }
        : {}),
    };
    await setSetting(photoMatchingKey, next, database);
    return next;
  });
}

const identityFields = ['name', 'maker', 'set', 'year', 'cardNumber', 'variant', 'serial'] as const;
type PrintedIdentity = Record<(typeof identityFields)[number], string>;
const normalize = (value: string) =>
  value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase();
function identity(analysis: PhotoAnalysis): PrintedIdentity {
  const result = Object.fromEntries(
    identityFields.map((field) => [field, normalize(analysis[field])]),
  ) as PrintedIdentity;
  if (/^#?\d+$/.test(result.cardNumber))
    result.cardNumber = result.cardNumber.replace(/^#/, '').replace(/^0+(?=\d)/, '');
  return result;
}
function identityKeys(value: PrintedIdentity) {
  const result: string[] = [];
  if (value.name)
    for (const context of ['maker', 'set', 'year'] as const)
      if (value[context])
        result.push(JSON.stringify(['name', value.name, context, value[context]]));
  if (value.cardNumber)
    for (const context of ['maker', 'set'] as const)
      if (value[context])
        result.push(JSON.stringify(['cardNumber', value.cardNumber, context, value[context]]));
  return result;
}
type Candidate = {
  key: string;
  source: FileReference;
  analysis: PhotoAnalysis;
  identity: PrintedIdentity;
  keys: string[];
};
type CandidateIndex = Map<string, Candidate[]>;
function compatible(a: Candidate, b: Candidate) {
  return identityFields.every(
    (field) => !a.identity[field] || !b.identity[field] || a.identity[field] === b.identity[field],
  );
}
function opposite(candidate: Candidate, index: CandidateIndex) {
  const seen = new Set<string>();
  let only: Candidate | null = null;
  for (const key of candidate.keys)
    for (const other of index.get(key) || []) {
      if (seen.has(other.key)) continue;
      seen.add(other.key);
      if (!compatible(candidate, other)) continue;
      if (only) return { count: 2, only: null };
      only = other;
    }
  return { count: only ? 1 : 0, only };
}

export function derivePhotoMatches(job: PhotoMatchingJob): {
  pairs: [FileReference, FileReference][];
  unmatched: { source: FileReference; analysis?: PhotoAnalysis; reason: string }[];
} {
  const fronts: Candidate[] = [];
  const byKey = new Map<string, Candidate>();
  const frontIndex: CandidateIndex = new Map(),
    backIndex: CandidateIndex = new Map();
  for (const source of job.files) {
    const key = fileKey(source),
      analysis = job.results[key]?.analysis;
    if (!analysis || analysis.side === 'unknown') continue;
    const printed = identity(analysis);
    const candidate: Candidate = {
      key,
      source,
      analysis,
      identity: printed,
      keys: identityKeys(printed),
    };
    byKey.set(key, candidate);
    const index = analysis.side === 'front' ? frontIndex : backIndex;
    if (analysis.side === 'front') fronts.push(candidate);
    for (const matchKey of candidate.keys) {
      const group = index.get(matchKey) || [];
      group.push(candidate);
      index.set(matchKey, group);
    }
  }
  const candidates = new Map<string, ReturnType<typeof opposite>>();
  const find = (candidate: Candidate) => {
    if (!candidates.has(candidate.key))
      candidates.set(
        candidate.key,
        opposite(candidate, candidate.analysis.side === 'front' ? backIndex : frontIndex),
      );
    return candidates.get(candidate.key)!;
  };
  const used = new Set<string>();
  const pairs: [FileReference, FileReference][] = structuredClone(job.reviewPairs ?? []);
  if (job.reviewPairs !== undefined) {
    for (const source of pairs.flat()) used.add(fileKey(source));
  } else {
    for (const front of fronts) {
      const back = find(front).only;
      if (
        back &&
        find(back).only?.key === front.key &&
        !used.has(front.key) &&
        !used.has(back.key)
      ) {
        pairs.push([front.source, back.source]);
        used.add(front.key);
        used.add(back.key);
      }
    }
  }
  const unmatched = job.files
    .filter((source) => !used.has(fileKey(source)))
    .map((source) => {
      const key = fileKey(source),
        outcome = job.results[key],
        analysis = outcome?.analysis;
      const candidate = byKey.get(key);
      let reason = outcome?.error || 'This photo has not been analyzed yet.';
      if (analysis?.side === 'unknown')
        reason = 'The photo side is uncertain. Choose its pair manually.';
      else if (candidate) {
        const matches = find(candidate);
        reason = !candidate.keys.length
          ? 'Not enough printed identity details to match safely.'
          : matches.count > 1 || (matches.only && find(matches.only).count > 1)
            ? 'Multiple photos share this identity. Choose the physical pair manually.'
            : job.reviewPairs !== undefined && matches.only
              ? 'This photo is not in a reviewed pair. Choose its pair manually.'
              : 'No compatible opposite side was found. Match this photo manually.';
      }
      return { source, ...(analysis ? { analysis } : {}), reason };
    });
  return { pairs, unmatched };
}
