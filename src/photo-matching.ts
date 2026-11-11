import { analyzePhotos, assertIdentificationReady } from './ai';
import {
  aiLeaseMs,
  normalizeIdentificationOptions,
  type IdentificationOptions,
} from './ai-options';
import { batchKey, checkBatchAllowance, withBatchLock, type IdentificationBatch } from './batch';
import { fileKey, type FileReference } from './bulk-entry';
import { db, type CabinetDB, friendlyError, setting, setSetting } from './db';
import {
  photoAnalysisResultSchema,
  type PhotoAnalysis,
  type PhotoAnalysisResult,
} from './photo-analysis';

export const photoMatchingKey = 'aiPhotoMatching';
export const photoMatchingLastAttemptKey = 'aiPhotoMatchingLastAttemptAt';
export type PhotoMatchingOutcome = { analysis?: PhotoAnalysis; error?: string };
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
};
export type PhotoMatchingActivity = {
  phase: 'analyzing' | 'waiting' | 'paused' | 'complete';
  until?: number;
};
type Lock = <T>(action: () => Promise<T>) => Promise<T>;
export type PhotoMatchingOptions = {
  database?: CabinetDB;
  lock?: Lock;
  analyze?: (blobs: Blob[], options: IdentificationOptions) => Promise<PhotoAnalysisResult>;
  ready?: () => Promise<void>;
  signal?: AbortSignal;
  now?: () => number;
  wait?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  onProgress?: (job: PhotoMatchingJob, activity?: PhotoMatchingActivity) => void;
};

export function getPhotoMatchingJob(database = db) {
  return setting<PhotoMatchingJob | null>(photoMatchingKey, null, database);
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
    const batch = await setting<IdentificationBatch | null>(batchKey, null, database);
    const lastAttemptAt = Math.max(
      await setting(photoMatchingLastAttemptKey, 0, database),
      batch?.lastStart || 0,
    );
    const job: PhotoMatchingJob = {
      version: 1,
      id: crypto.randomUUID(),
      files: structuredClone(files),
      identificationOptions: normalizeIdentificationOptions(identificationOptions),
      cursor: 0,
      processing: null,
      status: 'paused',
      lastAttemptAt,
      notBefore: batch?.processing ? now() + aiLeaseMs : 0,
      results: {},
      error: '',
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
    const saved = await getPhotoMatchingJob(database);
    if (!saved || saved.id !== id)
      throw new Error('The saved photo analysis changed. Reopen it before continuing.');
    let job: PhotoMatchingJob = saved;
    const progress = (activity: PhotoMatchingActivity) =>
      options.onProgress?.(structuredClone(job), activity);
    const save = () =>
      database.transaction('rw', database.settings, async () => {
        await setSetting(photoMatchingKey, job, database);
        await setSetting(photoMatchingLastAttemptKey, job.lastAttemptAt, database);
      });
    if (job.processing?.length) {
      for (const key of job.processing)
        job.results[key] = {
          error:
            'Interrupted request. Its outcome is unknown and it may have used API credit. This photo was not retried.',
        };
      job.cursor += job.processing.length;
      job.processing = null;
      job.notBefore = now() + aiLeaseMs;
      job.status = 'paused';
      await save();
    }
    if (job.cursor >= job.files.length) {
      job.status = 'complete';
      job.error = '';
      await save();
      progress({ phase: 'complete' });
      return job;
    }
    // Missing originals are recoverable and do not consume an attempt or skip photos.
    requireFiles(job.files.slice(job.cursor), files);
    await ready(options, database);
    await checkBatchAllowance(Math.ceil((job.files.length - job.cursor) / 2), database);
    const batch = await setting<IdentificationBatch | null>(batchKey, null, database);
    job.lastAttemptAt = Math.max(
      job.lastAttemptAt,
      batch?.lastStart || 0,
      await setting(photoMatchingLastAttemptKey, 0, database),
    );
    if (batch?.processing) job.notBefore = Math.max(job.notBefore, now() + aiLeaseMs);
    job.status = 'running';
    job.error = '';
    await save();
    try {
      while (job.cursor < job.files.length && !options.signal?.aborted) {
        const until = Math.max(job.lastAttemptAt + 15000, job.notBefore);
        const delay = Math.max(0, until - now());
        if (delay) {
          progress({ phase: 'waiting', until });
          await (options.wait || wait)(delay, options.signal);
        }
        if (options.signal?.aborted) break;
        const sources = job.files.slice(job.cursor, job.cursor + 2);
        const blobs = requireFiles(sources, files);
        job.processing = sources.map(fileKey);
        job.lastAttemptAt = now();
        job.notBefore = 0;
        await save();
        progress({ phase: 'analyzing' });
        let result: PhotoAnalysisResult;
        try {
          result = photoAnalysisResultSchema.parse(await analyze(blobs, job.identificationOptions));
          if (result.photos.length !== sources.length)
            throw new Error(
              'Photo analysis returned the wrong number of descriptions. No automatic retry was sent.',
            );
        } catch (error) {
          const message = friendlyError(error);
          for (const source of sources) job.results[fileKey(source)] = { error: message };
          job.cursor += sources.length;
          job.processing = null;
          job.lastAttemptAt = now();
          job.status = 'paused';
          job.error =
            message + ' Analysis stopped. These photos will not be retried automatically.';
          await save();
          progress({ phase: 'paused' });
          return job;
        }
        // Commit results and cursor together. A failed write leaves the in-flight checkpoint intact.
        const next: PhotoMatchingJob = {
          ...job,
          results: { ...job.results },
          cursor: job.cursor + sources.length,
          processing: null,
          lastAttemptAt: now(),
        };
        sources.forEach((source, index) => {
          next.results[fileKey(source)] = { analysis: result.photos[index] };
        });
        await database.transaction('rw', database.settings, async () => {
          await setSetting(photoMatchingKey, next, database);
          await setSetting(photoMatchingLastAttemptKey, next.lastAttemptAt, database);
        });
        job = next;
        progress({ phase: 'analyzing' });
      }
      job.status = job.cursor >= job.files.length ? 'complete' : 'paused';
      await save();
      progress({ phase: job.status });
      return job;
    } catch (error) {
      // Do not erase a persisted in-flight marker when storing a result failed.
      progress({ phase: 'paused' });
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
      if (job.processing?.length)
        await setSetting(
          photoMatchingLastAttemptKey,
          (options.now || Date.now)() + aiLeaseMs - 15000,
          database,
        );
      await database.settings.delete(photoMatchingKey);
    });
  });
}

function validateReviewedPairs(job: PhotoMatchingJob, pairs: [FileReference, FileReference][]) {
  if (job.status !== 'complete' || job.processing)
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
