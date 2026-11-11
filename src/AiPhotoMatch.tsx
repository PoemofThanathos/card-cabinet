import { useEffect, useMemo, useRef, useState } from 'react';
import { readIdentificationOptions } from './ai';
import { identificationLabel, type IdentificationOptions } from './ai-options';
import { fileKey, fileReference, validateSourceFiles, type FileReference } from './bulk-entry';
import { friendlyError } from './db';
import { PairPreview, PhotoPreview } from './PhotoPreview';
import { SpeedControl, useProcessingSpeed } from './SpeedControl';
import {
  createPhotoMatchingJob,
  analysisPendingFiles,
  getPhotoMatchingJob,
  runPhotoMatchingJob,
  deletePhotoMatchingJob,
  derivePhotoMatches,
  savePhotoMatchingReview,
  type PhotoMatchingJob,
} from './photo-matching';

type Pair = [FileReference, FileReference];
export function AiPhotoMatch({
  files,
  sources,
  onFiles,
  onBack,
  onUsePairs,
}: {
  files: File[];
  sources: FileReference[];
  onFiles: (files: File[]) => void;
  onBack: () => void;
  onUsePairs: (pairs: Pair[], job: PhotoMatchingJob) => Promise<void>;
}) {
  const [job, setJob] = useState<PhotoMatchingJob | null>(null);
  const [options, setOptions] = useState<IdentificationOptions | null>(null);
  const [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [activity, setActivity] = useState(''),
    [pairs, setPairs] = useState<Pair[]>([]),
    [page, setPage] = useState(0);
  const [front, setFront] = useState(''),
    [back, setBack] = useState(''),
    [inspect, setInspect] = useState('');
  const [discard, setDiscard] = useState(false);
  const [speed, setSpeed, speedReady] = useProcessingSpeed(setError);
  const controller = useRef<AbortController | null>(null);
  const mounted = useRef(true),
    backAfter = useRef(false);
  const fileMap = useMemo(() => new Map(files.map((file) => [fileKey(file), file])), [files]);
  useEffect(() => {
    mounted.current = true;
    void Promise.all([getPhotoMatchingJob(), readIdentificationOptions()])
      .then(([saved, selected]) => {
        if (!mounted.current) return;
        setJob(saved);
        setOptions(selected);
        if (saved?.status === 'complete') setPairs(derivePhotoMatches(saved).pairs);
      })
      .catch((e) => {
        if (mounted.current) setError(friendlyError(e));
      })
      .finally(() => {
        if (mounted.current) setLoading(false);
      });
    return () => {
      mounted.current = false;
      controller.current?.abort();
    };
  }, []);
  const selectedSources = job?.files ?? sources;
  const missing = selectedSources.filter((source) => !fileMap.has(fileKey(source))).length;
  const missingForAnalysis = (job ? analysisPendingFiles(job) : sources).some(
    (source) => !fileMap.has(fileKey(source)),
  );
  const suggestions = useMemo(
    () => (job?.status === 'complete' ? derivePhotoMatches(job) : null),
    [job],
  );
  const matched = new Set(pairs.flatMap((pair) => pair.map(fileKey)));
  const unmatched =
    job?.status === 'complete' ? job.files.filter((source) => !matched.has(fileKey(source))) : [];
  const currentPair = pairs[page];
  const inspected = unmatched.find((source) => fileKey(source) === inspect) ?? unmatched[0];
  async function run() {
    if (!options || busy || !speedReady) return;
    setBusy(true);
    setError('');
    backAfter.current = false;
    controller.current = new AbortController();
    try {
      const current = job ?? (await createPhotoMatchingJob(sources, options, { speed }));
      setJob(current);
      const finished = await runPhotoMatchingJob(current.id, fileMap, {
        speed,
        signal: controller.current.signal,
        onProgress: (next, state) => {
          if (!mounted.current) return;
          setJob(next);
          setActivity(
            state?.phase === 'waiting' ? 'Waiting before the next request…' : 'Reading photos…',
          );
        },
      });
      if (mounted.current) {
        setJob(finished);
        setActivity('');
        if (finished.status === 'complete') {
          setPairs(derivePhotoMatches(finished).pairs);
          setPage(0);
        }
      }
    } catch (e) {
      if (mounted.current) {
        setError(friendlyError(e));
        const saved = await getPhotoMatchingJob();
        setJob(saved);
      }
    } finally {
      controller.current = null;
      if (mounted.current) setBusy(false);
      if (backAfter.current) onBack();
    }
  }
  function leave() {
    if (busy) {
      backAfter.current = true;
      controller.current?.abort();
    } else onBack();
  }
  async function updatePairs(next: Pair[], nextPage = page) {
    if (!job || busy) return;
    setBusy(true);
    setError('');
    try {
      const saved = await savePhotoMatchingReview(job.id, next);
      if (mounted.current) {
        setJob(saved);
        setPairs(next);
        setPage(nextPage);
      }
    } catch (e) {
      if (mounted.current) setError(friendlyError(e));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  async function addPair() {
    const a = unmatched.find((source) => fileKey(source) === front),
      b = unmatched.find((source) => fileKey(source) === back);
    if (!a || !b || front === back) {
      setError('Choose two different photos.');
      return;
    }
    await updatePairs([...pairs, [a, b]], pairs.length);
    setFront('');
    setBack('');
    setError('');
  }
  async function accept() {
    if (!job || !pairs.length) return;
    setBusy(true);
    setError('');
    try {
      await onUsePairs(pairs, job);
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  async function discardJob() {
    if (!job) return;
    setBusy(true);
    try {
      await deletePhotoMatchingJob(job.id);
      setJob(null);
      setPairs([]);
      setDiscard(false);
      setError('');
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setBusy(false);
    }
  }
  if (loading) return <p>Loading AI photo matching…</p>;
  return (
    <section className="ai-photo-match">
      <h3>Match photos with AI</h3>
      <p>
        AI reads each photo, suggests front/back matches across the selection, and leaves uncertain
        matches for you.
      </p>
      <p className="small muted">
        {options && identificationLabel(job?.identificationOptions ?? options)}
      </p>
      {job?.status !== 'complete' && (
        <SpeedControl value={speed} onChange={setSpeed} disabled={busy || !speedReady} ai />
      )}
      {!job && (
        <>
          <p>
            {sources.length} photos · {Math.ceil(sources.length / 2)} matching requests
          </p>
          <p className="notice">
            Starting sends JPEG copies of these photos to your Worker and OpenAI, using your API
            balance. Location metadata is removed. After reviewing the pairs, save them and run card
            identification. Each card uses another request.
          </p>
        </>
      )}
      {missing > 0 && (
        <label>
          Reselect source photos to continue
          <input
            type="file"
            accept="image/*,.heic,.heif"
            multiple
            disabled={busy}
            onChange={(e) => {
              const chosen = Array.from(e.target.files ?? []);
              if (!chosen.length) return;
              try {
                validateSourceFiles(chosen);
                onFiles(chosen);
                setError('');
              } catch (err) {
                setError(friendlyError(err));
              }
            }}
          />
          <span className="small muted">
            {missing} original photos are needed. Your saved analysis is kept.
          </span>
        </label>
      )}
      {job && (
        <>
          <p role="status">
            {job.cursor} / {job.files.length} photos processed.{' '}
            {busy
              ? activity
              : job.status === 'complete'
                ? 'Ready to review.'
                : 'Paused. Resume continues with the remaining photos.'}
          </p>
          <progress
            aria-label="AI photo matching progress"
            max={Math.max(1, job.files.length)}
            value={job.cursor}
          />
          {job.error && <p className="notice warning">{job.error}</p>}
          <p className="small muted">
            Analysis is saved on this device. Keep the app open while it runs. Failed or interrupted
            requests are not retried automatically.
          </p>
        </>
      )}
      {job?.status === 'complete' && (
        <>
          <h3>
            {pairs.length} proposed {pairs.length === 1 ? 'pair' : 'pairs'} · {unmatched.length}{' '}
            unmatched {unmatched.length === 1 ? 'photo' : 'photos'}
          </h3>
          {currentPair && (
            <article className="bulk-review-card">
              <strong>Pair {page + 1}</strong>
              <PairPreview sources={currentPair} files={fileMap} />
              <p className="small muted">
                Check that both photos show the same physical card, including its variant and serial
                number.
              </p>
              <div className="button-row">
                <button
                  disabled={busy}
                  onClick={() =>
                    void updatePairs(
                      pairs.map((pair, i) => (i === page ? [pair[1], pair[0]] : pair)),
                    )
                  }
                >
                  Swap front and back
                </button>
                <button
                  disabled={busy}
                  onClick={() => {
                    void updatePairs(
                      pairs.filter((_, i) => i !== page),
                      Math.max(0, page - 1),
                    );
                  }}
                >
                  Unpair these photos
                </button>
              </div>
            </article>
          )}
          {pairs.length > 1 && (
            <nav className="bulk-pagination" aria-label="AI pair review pages">
              <button disabled={busy || page === 0} onClick={() => setPage((n) => n - 1)}>
                Previous pair
              </button>
              <span>
                {page + 1} / {pairs.length}
              </span>
              <button
                disabled={busy || page >= pairs.length - 1}
                onClick={() => setPage((n) => n + 1)}
              >
                Next pair
              </button>
            </nav>
          )}
          {unmatched.length > 0 && (
            <details open={!pairs.length}>
              <summary>
                Review {unmatched.length} unmatched {unmatched.length === 1 ? 'photo' : 'photos'}
              </summary>
              <p>
                Choose a front and back to pair manually. Unused photos and their analysis stay in
                this draft.
              </p>
              <label>
                Inspect photo
                <select
                  value={inspected ? fileKey(inspected) : ''}
                  onChange={(e) => setInspect(e.target.value)}
                >
                  {unmatched.map((source) => (
                    <option key={fileKey(source)} value={fileKey(source)}>
                      {source.name}
                    </option>
                  ))}
                </select>
              </label>
              {inspected && (
                <div className="bulk-photo-pair">
                  <PhotoPreview
                    source={inspected}
                    file={fileMap.get(fileKey(inspected))}
                    label="Unmatched photo"
                  />
                  <div>
                    <p>
                      {suggestions?.unmatched.find(
                        (item) => fileKey(item.source) === fileKey(inspected),
                      )?.reason ?? 'This photo was unpaired during review.'}
                    </p>
                    <p>
                      {job.results[fileKey(inspected)]?.error ??
                        job.results[fileKey(inspected)]?.analysis?.evidence ??
                        'No usable analysis.'}
                    </p>
                    <p className="small muted">
                      {job.results[fileKey(inspected)]?.analysis?.warnings.join(' ')}
                    </p>
                  </div>
                </div>
              )}
              {(['Front', 'Back'] as const).map((label, i) => (
                <label key={label}>
                  {label} photo
                  <select
                    aria-label={`Manual ${label.toLowerCase()} photo`}
                    value={i ? back : front}
                    disabled={busy}
                    onChange={(e) => (i ? setBack(e.target.value) : setFront(e.target.value))}
                  >
                    <option value="">Choose a photo</option>
                    {unmatched.map((source) => (
                      <option key={fileKey(source)} value={fileKey(source)}>
                        {source.name}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
              <button
                disabled={busy || !front || !back || front === back}
                onClick={() => void addPair()}
              >
                Pair selected photos
              </button>
            </details>
          )}
        </>
      )}
      {error && (
        <p role="alert" className="notice warning">
          {error}
        </p>
      )}
      <div className="modal-footer">
        <button disabled={busy && !controller.current} onClick={leave}>
          {busy ? 'Pause and return' : 'Back to import'}
        </button>
        {job?.status === 'complete' ? (
          <button
            className="primary"
            disabled={
              busy ||
              !pairs.length ||
              pairs.some((pair) => pair.some((source) => !fileMap.has(fileKey(source))))
            }
            onClick={() => void accept()}
          >
            Use {pairs.length} {pairs.length === 1 ? 'pair' : 'pairs'}
          </button>
        ) : (
          <button
            className="primary"
            disabled={
              busy || !speedReady || missingForAnalysis || !options || !selectedSources.length
            }
            onClick={() => void run()}
          >
            {busy
              ? 'Matching…'
              : job
                ? 'Resume AI matching'
                : `Send ${sources.length} photos to AI`}
          </button>
        )}
      </div>
      {job && !busy && (
        <div className="button-row">
          {discard ? (
            <>
              <p>Discard this analysis? Your original photos and saved cards are kept.</p>
              <button onClick={() => void discardJob()}>Discard analysis</button>
              <button onClick={() => setDiscard(false)}>Keep analysis</button>
            </>
          ) : (
            <button onClick={() => setDiscard(true)}>Discard matching draft</button>
          )}
        </div>
      )}
    </section>
  );
}
