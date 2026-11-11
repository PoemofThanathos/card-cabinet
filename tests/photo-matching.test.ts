import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Dexie from 'dexie';
import { CabinetDB, setting, setSetting } from '../src/db';
import { aiLeaseMs, type IdentificationOptions } from '../src/ai-options';
import { fileKey, fileReference, type FileReference } from '../src/bulk-entry';
import { type PhotoAnalysis, type PhotoAnalysisResult } from '../src/photo-analysis';
import {
  consumePhotoMatchingPairs,
  createPhotoMatchingJob,
  deletePhotoMatchingJob,
  derivePhotoMatches,
  getPhotoMatchingJob,
  photoMatchingKey,
  photoMatchingLastAttemptKey,
  runPhotoMatchingJob,
  savePhotoMatchingReview,
  type PhotoMatchingJob,
} from '../src/photo-matching';

let database: CabinetDB;
let clock: number;
const chosen: IdentificationOptions = { model: 'gpt-6.1-terra', reasoningEffort: 'high' };
const lock = async <T>(action: () => Promise<T>) => action();
const options = () => ({
  database,
  lock,
  ready: async () => {},
  now: () => clock,
  wait: async (milliseconds: number) => {
    clock += milliseconds;
  },
});
const analysis = (
  side: PhotoAnalysis['side'],
  number = '1',
  overrides: Partial<PhotoAnalysis> = {},
): PhotoAnalysis => ({
  side,
  name: 'Player ' + number,
  maker: 'Topps',
  set: 'Stadium Club NPB',
  year: '2026',
  cardNumber: number,
  variant: 'Base',
  serial: '',
  evidence: 'Printed card details',
  warnings: [],
  ...overrides,
});
function originals(count: number) {
  const files = Array.from(
    { length: count },
    (_, i) =>
      new File(['fixture-' + i], 'photo-' + i + '.jpg', { type: 'image/jpeg', lastModified: 1234 }),
  );
  return {
    refs: files.map(fileReference),
    map: new Map(files.map((file) => [fileKey(file), file])),
  };
}
const analyze = vi.fn(async (blobs: Blob[]): Promise<PhotoAnalysisResult> => ({
  photos: blobs.map((blob) => {
    const n = Number((blob as File).name.match(/\d+/)?.[0]);
    return analysis(n % 2 ? 'back' : 'front', String(Math.floor(n / 2) + 1));
  }),
}));
function described(photos: PhotoAnalysis[]): PhotoMatchingJob {
  const { refs } = originals(photos.length);
  return {
    version: 1,
    id: 'described',
    files: refs,
    identificationOptions: chosen,
    cursor: refs.length,
    processing: null,
    status: 'complete',
    lastAttemptAt: 0,
    notBefore: 0,
    error: '',
    results: Object.fromEntries(
      refs.map((source, i) => [fileKey(source), { analysis: photos[i] }]),
    ),
  };
}

beforeEach(async () => {
  database = new CabinetDB('photo-match-' + crypto.randomUUID());
  await database.open();
  await setSetting('aiUnlimited', true, database);
  clock = Date.now();
  analyze.mockClear();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await database.delete();
});

describe('global photo pairing', () => {
  it('matches all fronts followed by shuffled backs across request boundaries', () => {
    const job = described([
      analysis('front', '1'),
      analysis('front', '2'),
      analysis('front', '3'),
      analysis('back', '3'),
      analysis('back', '1'),
      analysis('back', '2'),
    ]);
    const { pairs, unmatched } = derivePhotoMatches(job);
    expect(pairs.map(([front, back]) => [front.name, back.name])).toEqual([
      ['photo-0.jpg', 'photo-4.jpg'],
      ['photo-1.jpg', 'photo-5.jpg'],
      ['photo-2.jpg', 'photo-3.jpg'],
    ]);
    expect(unmatched).toEqual([]);
  });

  it('accepts name plus shared maker even when fronts lack a set and year', () => {
    const job = described([
      analysis('front', '', { name: '大谷　翔平', set: '', year: '', variant: '' }),
      analysis('back', '', { name: '大谷 翔平', maker: 'ＴＯＰＰＳ', variant: '' }),
    ]);
    expect(derivePhotoMatches(job).pairs).toHaveLength(1);
  });

  it('accepts printed number plus set without requiring readable names', () => {
    const job = described([
      analysis('back', '#001', { name: '', maker: '', year: '' }),
      analysis('front', '１', { name: '', maker: '', year: '' }),
    ]);
    expect(derivePhotoMatches(job).pairs[0].map((source) => source.name)).toEqual([
      'photo-1.jpg',
      'photo-0.jpg',
    ]);
  });

  it.each(['name', 'maker', 'set', 'year', 'cardNumber', 'variant', 'serial'] as const)(
    'does not pair conflicting nonempty %s values',
    (field) => {
      const front = analysis('front', '1', field === 'serial' ? { serial: '01/25' } : {});
      const back = analysis('back', '1', { [field]: 'different' });
      const match = derivePhotoMatches(described([front, back]));
      expect(match.pairs).toEqual([]);
      expect(match.unmatched).toHaveLength(2);
    },
  );

  it('keeps duplicate physical copies ambiguous instead of assigning by order', () => {
    const job = described([
      analysis('front'),
      analysis('back'),
      analysis('front'),
      analysis('back'),
    ]);
    const match = derivePhotoMatches(job);
    expect(match.pairs).toHaveLength(0);
    expect(match.unmatched).toHaveLength(4);
    expect(match.unmatched.every((item) => item.reason.includes('Multiple photos'))).toBe(true);
  });

  it('can distinguish duplicate identities when both sides share different printed serials', () => {
    const job = described([
      analysis('front', '1', { serial: '01/25' }),
      analysis('back', '1', { serial: '02/25' }),
      analysis('front', '1', { serial: '02/25' }),
      analysis('back', '1', { serial: '01/25' }),
    ]);
    expect(derivePhotoMatches(job).pairs.map((pair) => pair.map((source) => source.name))).toEqual([
      ['photo-0.jpg', 'photo-3.jpg'],
      ['photo-2.jpg', 'photo-1.jpg'],
    ]);
  });

  it('preserves every unknown, weak, failed and unused photo exactly once', () => {
    const weak = {
      name: '',
      maker: '',
      set: '',
      year: '',
      cardNumber: '',
      variant: '',
      serial: '',
    };
    const job = described([
      analysis('front'),
      analysis('back'),
      analysis('unknown'),
      analysis('front', '', weak),
      analysis('back', '', weak),
    ]);
    job.files.push({ name: 'failed.jpg', size: 9, lastModified: 1 });
    job.results[fileKey(job.files[5])] = { error: 'Request failed' };
    const match = derivePhotoMatches(job);
    const keys = [...match.pairs.flat(), ...match.unmatched.map((item) => item.source)].map(
      fileKey,
    );
    expect(new Set(keys).size).toBe(job.files.length);
    expect(keys).toHaveLength(job.files.length);
    expect(match.pairs).toHaveLength(1);
    expect(match.unmatched.find((item) => item.source.name === 'failed.jpg')?.reason).toBe(
      'Request failed',
    );
  });
});

describe('photo analysis progress', () => {
  it('honors the saved matching timestamp when creating another job', async () => {
    const { refs, map } = originals(2);
    await setSetting(photoMatchingLastAttemptKey, clock, database);
    const previousAttempt = clock;
    const job = await createPhotoMatchingJob(refs, chosen, options());
    expect(job.lastAttemptAt).toBe(previousAttempt);
    const starts: number[] = [];
    await runPhotoMatchingJob(job.id, map, {
      ...options(),
      analyze: async (blobs) => {
        starts.push(clock);
        return analyze(blobs);
      },
    });
    expect(starts[0] - previousAttempt).toBeGreaterThanOrEqual(15000);
  });

  it('waits out an interrupted identification lease when resuming an older matching job', async () => {
    const { refs, map } = originals(2);
    const job = await createPhotoMatchingJob(refs, chosen, options());
    await setSetting('aiBatch', { processing: 'unknown-card', lastStart: clock }, database);
    const resumedAt = clock;
    await runPhotoMatchingJob(job.id, map, { ...options(), analyze });
    expect(analyze).toHaveBeenCalledTimes(1);
    expect(clock - resumedAt).toBeGreaterThanOrEqual(aiLeaseMs);
  });

  it('analyzes more than 100 files in ordered chunks of two and snapshots settings', async () => {
    const { refs, map } = originals(103);
    const job = await createPhotoMatchingJob(refs, chosen, options());
    await setSetting('aiOptions', { model: 'gpt-6-astra', reasoningEffort: 'low' }, database);
    const starts: number[] = [];
    const completions: number[] = [];
    const runner = vi.fn(async (blobs: Blob[], actual: IdentificationOptions) => {
      expect(actual).toEqual(chosen);
      starts.push(clock);
      clock += 700;
      const result = await analyze(blobs);
      completions.push(clock);
      return result;
    });
    const finished = await runPhotoMatchingJob(job.id, map, { ...options(), analyze: runner });
    expect(finished.status).toBe('complete');
    expect(finished.cursor).toBe(103);
    expect(Object.keys(finished.results)).toHaveLength(103);
    expect(runner).toHaveBeenCalledTimes(52);
    expect(runner.mock.calls.at(-1)![0]).toHaveLength(1);
    expect(starts.slice(1).every((start, i) => start - completions[i] >= 15000)).toBe(true);
    expect(derivePhotoMatches(finished).pairs).toHaveLength(51);
    expect(derivePhotoMatches(finished).unmatched).toHaveLength(1);
  });

  it('pauses after the active chunk and resumes only its remaining files', async () => {
    const { refs, map } = originals(6);
    const job = await createPhotoMatchingJob(refs, chosen, options());
    const control = new AbortController();
    const first = vi.fn(async (blobs: Blob[]) => {
      control.abort();
      return analyze(blobs);
    });
    const paused = await runPhotoMatchingJob(job.id, map, {
      ...options(),
      signal: control.signal,
      analyze: first,
    });
    expect(paused.status).toBe('paused');
    expect(paused.cursor).toBe(2);
    expect(Object.keys(paused.results)).toHaveLength(2);
    analyze.mockClear();
    const finished = await runPhotoMatchingJob(job.id, map, { ...options(), analyze });
    expect(finished.status).toBe('complete');
    expect(analyze).toHaveBeenCalledTimes(2);
    expect((analyze.mock.calls[0][0][0] as File).name).toBe('photo-2.jpg');
  });

  it('never retries interrupted photos and waits out the entire lease before continuing', async () => {
    const { refs, map } = originals(4);
    const job = await createPhotoMatchingJob(refs, chosen, options());
    job.processing = refs.slice(0, 2).map(fileKey);
    job.status = 'running';
    await setSetting(photoMatchingKey, job, database);
    const began = clock;
    const finished = await runPhotoMatchingJob(job.id, map, { ...options(), analyze });
    expect(analyze).toHaveBeenCalledTimes(1);
    expect((analyze.mock.calls[0][0][0] as File).name).toBe('photo-2.jpg');
    expect(clock - began).toBeGreaterThanOrEqual(aiLeaseMs);
    expect(finished.results[fileKey(refs[0])].error).toContain('not retried');
    expect(derivePhotoMatches(finished).unmatched).toHaveLength(2);
  });

  it('keeps earlier results and skips failed requests when continuing', async () => {
    const { refs, map } = originals(6);
    const job = await createPhotoMatchingJob(refs, chosen, options());
    let calls = 0;
    const failed = await runPhotoMatchingJob(job.id, map, {
      ...options(),
      analyze: async (blobs) => {
        if (++calls === 2) throw new Error('Quota exhausted');
        return analyze(blobs);
      },
    });
    expect(failed.status).toBe('paused');
    expect(failed.cursor).toBe(4);
    expect(failed.results[fileKey(refs[0])].analysis).toBeDefined();
    expect(failed.results[fileKey(refs[2])].error).toBe('Quota exhausted');
    analyze.mockClear();
    const finished = await runPhotoMatchingJob(job.id, map, { ...options(), analyze });
    expect(analyze).toHaveBeenCalledTimes(1);
    expect((analyze.mock.calls[0][0][0] as File).name).toBe('photo-4.jpg');
    expect(finished.status).toBe('complete');
  });

  it('retains a before-send marker when storing the returned analysis fails', async () => {
    const { refs, map } = originals(4);
    const job = await createPhotoMatchingJob(refs, chosen, options());
    const original = database.settings.put.bind(database.settings);
    const write = vi.spyOn(database.settings, 'put').mockImplementation((row) => {
      if (
        row.key === photoMatchingKey &&
        (row.value as PhotoMatchingJob).cursor === 2 &&
        !(row.value as PhotoMatchingJob).processing
      )
        return Dexie.Promise.reject(new Error('Storage full'));
      return original(row);
    });
    await expect(runPhotoMatchingJob(job.id, map, { ...options(), analyze })).rejects.toThrow(
      'Storage full',
    );
    const saved = await getPhotoMatchingJob(database);
    expect(saved?.processing).toEqual(refs.slice(0, 2).map(fileKey));
    expect(saved?.cursor).toBe(0);
    write.mockRestore();
    analyze.mockClear();
    await runPhotoMatchingJob(job.id, map, { ...options(), analyze });
    expect(analyze).toHaveBeenCalledTimes(1);
    expect((analyze.mock.calls[0][0][0] as File).name).toBe('photo-2.jpg');
  });

  it('requires original files and sufficient attempt allowance before sending anything', async () => {
    const { refs, map } = originals(6);
    const job = await createPhotoMatchingJob(refs, chosen, options());
    map.delete(fileKey(refs[5]));
    await expect(runPhotoMatchingJob(job.id, map, { ...options(), analyze })).rejects.toThrow(
      'original photo',
    );
    expect(analyze).not.toHaveBeenCalled();
    expect((await getPhotoMatchingJob(database))?.cursor).toBe(0);
    const restored = originals(6).map;
    await setSetting('aiUnlimited', false, database);
    await setSetting('aiUsage', { day: new Date().toISOString().slice(0, 10), count: 1 }, database);
    await expect(runPhotoMatchingJob(job.id, restored, { ...options(), analyze })).rejects.toThrow(
      '2 left',
    );
    expect(analyze).not.toHaveBeenCalled();
  });

  it('requires explicit discard before replacing a saved job', async () => {
    const { refs } = originals(3);
    const job = await createPhotoMatchingJob(refs, chosen, options());
    await expect(createPhotoMatchingJob(refs, chosen, options())).rejects.toThrow(
      'explicitly discard',
    );
    await deletePhotoMatchingJob(job.id, options());
    const next = await createPhotoMatchingJob(refs, chosen, options());
    expect(next.id).not.toBe(job.id);
  });
});

describe('saved pair review', () => {
  it('keeps swapped and manual pairs through reopening without regenerating AI proposals', async () => {
    const job = described([
      analysis('front'),
      analysis('back'),
      analysis('unknown'),
      analysis('unknown'),
    ]);
    await setSetting(photoMatchingKey, job, database);
    const pairs: [FileReference, FileReference][] = [
      [job.files[1], job.files[0]],
      [job.files[2], job.files[3]],
    ];
    const saved = await savePhotoMatchingReview(job.id, pairs, options());
    expect(saved.reviewPairs).toEqual(pairs);
    const reopened = (await getPhotoMatchingJob(database))!;
    expect(derivePhotoMatches(reopened)).toEqual({ pairs, unmatched: [] });
    expect(reopened.results).toEqual(job.results);
    expect(analyze).not.toHaveBeenCalled();
  });

  it('keeps an explicitly empty review so rejected AI pairs do not reappear', async () => {
    const job = described([analysis('front'), analysis('back')]);
    await setSetting(photoMatchingKey, job, database);
    expect(derivePhotoMatches(job).pairs).toHaveLength(1);
    await savePhotoMatchingReview(job.id, [], options());
    const reopened = (await getPhotoMatchingJob(database))!;
    expect(reopened.reviewPairs).toEqual([]);
    expect(derivePhotoMatches(reopened).pairs).toEqual([]);
    expect(derivePhotoMatches(reopened).unmatched).toHaveLength(2);
    expect(derivePhotoMatches(reopened).unmatched[0].reason).toContain('not in a reviewed pair');
  });

  it('rejects unknown or reused sources and unfinished or replaced jobs without overwriting a review', async () => {
    const job = described([analysis('front'), analysis('back')]);
    await setSetting(photoMatchingKey, job, database);
    const pair: [FileReference, FileReference] = [job.files[0], job.files[1]];
    await savePhotoMatchingReview(job.id, [pair], options());
    const before = await getPhotoMatchingJob(database);
    const unknown = { name: 'other.jpg', size: 1, lastModified: 2 };
    for (const pairs of [[pair, pair], [[job.files[0], unknown]], [[job.files[0], job.files[0]]]]) {
      await expect(
        savePhotoMatchingReview(job.id, pairs as [FileReference, FileReference][], options()),
      ).rejects.toThrow('known and used only once');
      expect(await getPhotoMatchingJob(database)).toEqual(before);
    }
    await expect(savePhotoMatchingReview('other-job', [], options())).rejects.toThrow('changed');
    await setSetting(photoMatchingKey, { ...job, status: 'paused' }, database);
    await expect(savePhotoMatchingReview(job.id, [pair], options())).rejects.toThrow('Finish');
    await setSetting(photoMatchingKey, { ...job, processing: [fileKey(job.files[0])] }, database);
    await expect(savePhotoMatchingReview(job.id, [pair], options())).rejects.toThrow('Finish');
  });

  it('leaves the previous review intact if the new review cannot be stored', async () => {
    const job = described([analysis('front'), analysis('back')]);
    await setSetting(photoMatchingKey, job, database);
    const lockSpy = vi.fn();
    const observedLock = async <T>(action: () => Promise<T>) => {
      lockSpy();
      return action();
    };
    vi.spyOn(database.settings, 'put').mockImplementation(() => {
      throw new Error('Storage full');
    });
    await expect(
      savePhotoMatchingReview(job.id, [], { ...options(), lock: observedLock }),
    ).rejects.toThrow('Storage full');
    expect(lockSpy).toHaveBeenCalledTimes(1);
    expect(await getPhotoMatchingJob(database)).toEqual(job);
  });

  it('retains remaining manual pairs when other photos are consumed', async () => {
    const job = described(Array.from({ length: 6 }, () => analysis('unknown')));
    await setSetting(photoMatchingKey, job, database);
    const pairs: [FileReference, FileReference][] = [
      [job.files[1], job.files[0]],
      [job.files[3], job.files[2]],
      [job.files[4], job.files[5]],
    ];
    await savePhotoMatchingReview(job.id, pairs, options());
    const remainder = await consumePhotoMatchingPairs(job.id, [pairs[0]], database);
    expect(remainder?.reviewPairs).toEqual(pairs.slice(1));
    expect(derivePhotoMatches(remainder!).pairs).toEqual(pairs.slice(1));
    const partial = await consumePhotoMatchingPairs(
      job.id,
      [[job.files[2], job.files[4]]],
      database,
    );
    expect(partial?.reviewPairs).toEqual([]);
    expect(derivePhotoMatches(partial!).unmatched.map((item) => item.source)).toEqual([
      job.files[3],
      job.files[5],
    ]);
  });
});

describe('accepting reviewed pairs', () => {
  it('atomically consumes only accepted photos while retaining unmatched analysis', async () => {
    const job = described([analysis('front'), analysis('back'), analysis('unknown')]);
    await setSetting(photoMatchingKey, job, database);
    const pairs = derivePhotoMatches(job).pairs;
    await database.transaction('rw', database.settings, async () => {
      await setSetting('bulkEntryDraft', { saved: true }, database);
      await consumePhotoMatchingPairs(job.id, pairs, database);
    });
    const saved = await getPhotoMatchingJob(database);
    expect(saved?.files).toEqual([job.files[2]]);
    expect(saved?.cursor).toBe(1);
    expect(saved?.status).toBe('complete');
    expect(Object.keys(saved!.results)).toEqual([fileKey(job.files[2])]);
    await expect(consumePhotoMatchingPairs(job.id, pairs, database)).rejects.toThrow('known');
  });

  it('rolls back accepted pairs with the caller transaction and rejects reused photos', async () => {
    const job = described([analysis('front'), analysis('back')]);
    await setSetting(photoMatchingKey, job, database);
    const pair: [FileReference, FileReference] = [job.files[0], job.files[1]];
    await expect(consumePhotoMatchingPairs(job.id, [pair, pair], database)).rejects.toThrow(
      'only once',
    );
    await expect(
      database.transaction('rw', database.settings, async () => {
        await consumePhotoMatchingPairs(job.id, [pair], database);
        throw new Error('Draft failed');
      }),
    ).rejects.toThrow('Draft failed');
    expect((await getPhotoMatchingJob(database))?.files).toHaveLength(2);
    await setSetting(photoMatchingLastAttemptKey, 123, database);
    await consumePhotoMatchingPairs(job.id, [pair], database);
    expect(await getPhotoMatchingJob(database)).toBeNull();
    expect(await setting(photoMatchingLastAttemptKey, 0, database)).toBe(123);
  });

  it('refuses acceptance before the job completes', async () => {
    const job = described([analysis('front'), analysis('back')]);
    job.status = 'paused';
    await setSetting(photoMatchingKey, job, database);
    await expect(
      consumePhotoMatchingPairs(job.id, [[job.files[0], job.files[1]]], database),
    ).rejects.toThrow('Finish photo analysis');
  });
});
