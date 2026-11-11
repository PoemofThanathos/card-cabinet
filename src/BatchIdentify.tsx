import { useEffect, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { type Card, title } from './model';
import { db, friendlyError, setting } from './db';
import { Modal } from './components';
import { SuggestionReview } from './Editor';
import { SpeedControl, useProcessingSpeed } from './SpeedControl';
import { readIdentificationOptions } from './ai';
import { identificationLabel, normalizeIdentificationOptions } from './ai-options';
import {
  applyBatchReview,
  batchKey,
  createBatch,
  reviewPrefix,
  runBatch,
  type BatchActivity,
  type BatchReview,
  type IdentificationBatch,
} from './batch';

function reviewTitle(review: BatchReview) {
  if (title(review.card) !== 'Untitled card') return title(review.card);
  return (
    review.result.suggestions.find(
      (suggestion) =>
        (suggestion.field === 'name' || suggestion.field === 'japaneseName') &&
        !suggestion.uncertain &&
        suggestion.value,
    )?.value || title(review.card)
  );
}

export function BatchIdentify({
  cards,
  onClose,
  onMessage,
}: {
  cards: Card[];
  onClose: () => void;
  onMessage: (s: string) => void;
}) {
  const batch = useLiveQuery(() => setting<IdentificationBatch | null>(batchKey, null), []);
  const chosenOptions = useLiveQuery(() => readIdentificationOptions(), []);
  const reviewCount =
    useLiveQuery(() => db.settings.where('key').startsWith(reviewPrefix).count(), []) || 0;
  const [page, setPage] = useState(0);
  const reviews =
    useLiveQuery(
      () =>
        db.settings
          .where('key')
          .startsWith(reviewPrefix)
          .offset(page * 8)
          .limit(8)
          .toArray(),
      [page],
    ) || [];
  const [savedView, setSavedView] = useState(cards.length === 0),
    [busy, setBusy] = useState(false),
    [applying, setApplying] = useState(false),
    [error, setError] = useState(''),
    [pausing, setPausing] = useState(false),
    [activity, setActivity] = useState<BatchActivity>({ phase: 'idle' }),
    [review, setReview] = useState<{ key: string; value: BatchReview } | null>(null),
    [failurePage, setFailurePage] = useState(0);
  const [speed, setSpeed, speedReady] = useProcessingSpeed(setError);
  const controller = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const closeWhenPaused = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      controller.current?.abort();
    };
  }, []);
  useEffect(() => {
    if (page && page * 8 >= reviewCount) setPage(Math.max(0, Math.ceil(reviewCount / 8) - 1));
  }, [page, reviewCount]);

  async function start(replace: boolean) {
    if (busy || !speedReady) return;
    setBusy(true);
    setPausing(false);
    setError('');
    controller.current = new AbortController();
    try {
      if (replace && !chosenOptions) throw new Error('Identification settings are still loading.');
      const job = replace
        ? await createBatch(
            cards.map((card) => card.id),
            { identificationOptions: chosenOptions, speed },
          )
        : batch;
      if (!job) throw new Error('No saved batch is available.');
      setSavedView(true);
      const finished = await runBatch(job.id, {
        speed,
        signal: controller.current.signal,
        onActivity: (value) => {
          if (mounted.current) setActivity(value);
        },
      });
      if (mounted.current)
        onMessage(
          finished.status === 'complete'
            ? 'Batch identification finished. Review the saved suggestions.'
            : 'Batch paused. Progress and suggestions are saved here.',
        );
    } catch (e) {
      if (mounted.current) setError(friendlyError(e));
    } finally {
      if (mounted.current) {
        setBusy(false);
        setPausing(false);
        setActivity({ phase: 'idle' });
        if (closeWhenPaused.current) onClose();
      }
    }
  }
  function pause(close = false) {
    closeWhenPaused.current = close;
    setPausing(true);
    controller.current?.abort();
  }
  function close() {
    if (applying) return;
    if (busy) pause(true);
    else onClose();
  }
  async function apply(values: Partial<Card['fields']>) {
    if (!review || applying) return;
    setApplying(true);
    setError('');
    try {
      await applyBatchReview(review.key, values);
      setReview(null);
      onMessage('Reviewed fields saved on this device.');
    } catch (e) {
      setReview(null);
      setError(friendlyError(e));
    } finally {
      setApplying(false);
    }
  }
  async function discard(key: string) {
    if (applying) return;
    try {
      await db.settings.delete(key);
    } catch (e) {
      setError(friendlyError(e));
    }
  }
  const pending = batch
    ? Math.max(
        0,
        batch.cardIds.length - (batch.nextPosition ?? batch.position + (batch.processing ? 1 : 0)),
      )
    : 0;
  return (
    <Modal title="Batch identification" onClose={close} wide>
      {!savedView && (
        <>
          <p>
            This batch contains <strong>{cards.length}</strong> cards. Starting it sends both photos
            of each card to your Worker and OpenAI using your API balance.
          </p>
          <p>Keep this app open while it runs. Review the suggestions before applying fields.</p>
          {chosenOptions && (
            <p className="small muted">
              {identificationLabel(chosenOptions)}. This choice stays with the batch when you pause
              or change Settings.
            </p>
          )}
          <SpeedControl value={speed} onChange={setSpeed} disabled={busy || !speedReady} ai />
          <ol>
            {cards.slice(0, 8).map((card) => (
              <li key={card.id}>
                {title(card)}
                {card.fields.cardNumber ? ' · #' + card.fields.cardNumber : ''}
              </li>
            ))}
          </ol>
          {cards.length > 8 && <p className="small muted">And {cards.length - 8} more cards.</p>}
          {batch && (
            <p className="notice">
              A saved queue already exists. Starting this batch replaces its remaining queue. Saved
              suggestions are kept.
            </p>
          )}
          <div className="button-row">
            <button
              className="primary"
              disabled={busy || batch === undefined || !chosenOptions || !speedReady}
              onClick={() => void start(true)}
            >
              {batch ? 'Replace queue and start ' : 'Start identification of '}
              {cards.length} cards
            </button>
            {batch && (
              <button disabled={busy} onClick={() => setSavedView(true)}>
                Open saved batch
              </button>
            )}
          </div>
        </>
      )}
      {savedView && batch && (
        <>
          <p className="small muted">
            {identificationLabel(normalizeIdentificationOptions(batch.identificationOptions))}
          </p>
          <p role="status" aria-live="polite">
            <strong>
              {batch.position} / {batch.cardIds.length}
            </strong>{' '}
            processed. {batch.failures.length} failed or interrupted.
          </p>
          <progress
            value={batch.position}
            max={batch.cardIds.length}
            aria-label="Batch identification progress"
            style={{ width: '100%' }}
          />
          {busy ? (
            <>
              <p role="status">
                {pausing
                  ? 'Pausing after active requests finish…'
                  : activity.phase === 'waiting'
                    ? 'Waiting before the next scan…'
                    : `Identifying cards · ${batch.inFlight?.length ?? 1} active requests…`}
              </p>
              <button disabled={pausing} onClick={() => pause()}>
                Pause batch
              </button>
            </>
          ) : (
            <>
              {batch.processing && (
                <p className="notice warning">
                  Requests were in progress. If another tab is running, pause it there. After an
                  interruption, its outcome is unknown and it may have used API credit. Continuing
                  skips those requests and waits for its server reservation to expire.
                </p>
              )}
              {pending > 0 ? (
                <>
                  <p>
                    Continue automatically with {pending} remaining cards. Each sends two photos and
                    uses your API balance.
                  </p>
                  <SpeedControl
                    value={speed}
                    onChange={setSpeed}
                    disabled={busy || !speedReady}
                    ai
                  />
                  <button
                    className="primary"
                    disabled={!speedReady}
                    onClick={() => void start(false)}
                  >
                    Continue {pending} remaining cards
                  </button>
                </>
              ) : batch.processing ? (
                <button onClick={() => void start(false)}>Mark interrupted scan and finish</button>
              ) : (
                <p>Queue finished. Saved suggestions are ready to review.</p>
              )}
            </>
          )}
          {batch.error && (
            <p role="alert" className="notice warning">
              {batch.error}
            </p>
          )}
          {batch.failures.length > 0 && (
            <details>
              <summary>Failed or interrupted cards · {batch.failures.length}</summary>
              <p className="small muted">
                These cards stay in your collection. Open a card to retry it deliberately after
                checking the error.
              </p>
              <ul>
                {batch.failures
                  .slice(failurePage * 8, failurePage * 8 + 8)
                  .map((failure, index) => (
                    <li key={failure.cardId + index}>
                      <strong>{failure.name}</strong>
                      <p>{failure.error}</p>
                    </li>
                  ))}
              </ul>
              {batch.failures.length > 8 && (
                <div className="button-row">
                  <button disabled={!failurePage} onClick={() => setFailurePage(failurePage - 1)}>
                    Previous failures
                  </button>
                  <button
                    disabled={(failurePage + 1) * 8 >= batch.failures.length}
                    onClick={() => setFailurePage(failurePage + 1)}
                  >
                    Next failures
                  </button>
                </div>
              )}
            </details>
          )}
        </>
      )}
      {savedView && batch === null && (
        <p>No saved batch. Select collection cards or add photos in bulk to start one.</p>
      )}
      {error && (
        <p role="alert" className="notice warning">
          {error}
        </p>
      )}
      {reviewCount > 0 && (
        <section>
          <h3>Suggestions to review · {reviewCount}</h3>
          <p className="small muted">
            Progress and suggestions are saved only on this device. They are not included in card
            backups until you apply the fields.
          </p>
          <ul>
            {reviews.map((row) => {
              const value = row.value as BatchReview;
              return (
                <li key={row.key}>
                  <div className="button-row">
                    <button disabled={applying} onClick={() => setReview({ key: row.key, value })}>
                      Review {reviewTitle(value)}
                      {value.card.fields.cardNumber ? ' · #' + value.card.fields.cardNumber : ''}
                    </button>
                    <button
                      disabled={applying}
                      aria-label={
                        'Discard suggestions for ' +
                        reviewTitle(value) +
                        (value.card.fields.cardNumber ? ' #' + value.card.fields.cardNumber : '')
                      }
                      onClick={() => void discard(row.key)}
                    >
                      Discard
                    </button>
                  </div>
                  {value.card.fields.notes && (
                    <p className="small muted">{value.card.fields.notes}</p>
                  )}
                </li>
              );
            })}
          </ul>
          {reviewCount > 8 && (
            <div className="button-row">
              <button disabled={!page} onClick={() => setPage(page - 1)}>
                Previous suggestions
              </button>
              <span>
                {page + 1} / {Math.ceil(reviewCount / 8)}
              </span>
              <button disabled={(page + 1) * 8 >= reviewCount} onClick={() => setPage(page + 1)}>
                Next suggestions
              </button>
            </div>
          )}
        </section>
      )}
      <div className="modal-footer">
        <button disabled={applying || pausing} onClick={close}>
          {busy ? 'Pause and close' : 'Close batch'}
        </button>
      </div>
      {review && (
        <SuggestionReview
          key={review.key}
          card={review.value.card}
          result={review.value.result}
          identificationOptions={normalizeIdentificationOptions(review.value.identificationOptions)}
          closeLabel="Close review"
          onApply={(values) => void apply(values)}
          onClose={() => {
            if (!applying) setReview(null);
          }}
        />
      )}
    </Modal>
  );
}
