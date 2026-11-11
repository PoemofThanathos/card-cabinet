import { useEffect, useMemo, useRef, useState } from 'react';
import { Modal } from './components';
import { db, friendlyError } from './db';
import { type Field, categories, fieldLabels, products } from './model';
import { PairPreview } from './PhotoPreview';
import { AiPhotoMatch } from './AiPhotoMatch';
import {
  consumePhotoMatchingPairs,
  getPhotoMatchingJob,
  type PhotoMatchingJob,
} from './photo-matching';
import {
  type BulkEntryPlan,
  type OwnershipMode,
  type PairOrder,
  type FileReference,
  baseSelection,
  bulkCard,
  cardNumbers,
  fileKey,
  fileReference,
  getBulkEntryPlan,
  manualRows,
  numberCount,
  pairPhotos,
  savedEntryIds,
  saveBulkEntry,
  storeBulkEntryPlan,
  changeBulkEntry,
  validateSourceFiles,
  deleteBulkEntryPlan,
} from './bulk-entry';
import './bulk.css';

export function BulkAdd({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: (cardIds: string[], identify: boolean) => void;
}) {
  const [kind, setKind] = useState<BulkEntryPlan['kind']>('photos');
  const [common, setCommon] = useState<Partial<Record<Field, string>>>({
    product: 'Baseball card',
  });
  const [files, setFiles] = useState<File[]>([]),
    [order, setOrder] = useState<PairOrder>('alternating');
  const [rows, setRows] = useState(''),
    [checklist, setChecklist] = useState('');
  const [ownership, setOwnership] = useState<OwnershipMode>('complete'),
    [numbers, setNumbers] = useState('');
  const [summary, setSummary] = useState(''),
    [plan, setPlan] = useState<BulkEntryPlan | null>(null);
  const [persisted, setPersisted] = useState(false),
    [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [page, setPage] = useState(0);
  const [aiMode, setAiMode] = useState(false),
    [hasAiDraft, setHasAiDraft] = useState(false);
  const paused = useRef(false),
    closeAfter = useRef(false),
    active = useRef(true);
  const fileMap = useMemo(() => new Map(files.map((file) => [fileKey(file), file])), [files]);
  useEffect(() => {
    active.current = true;
    void Promise.all([getBulkEntryPlan(), getPhotoMatchingJob()])
      .then(([saved, matching]) => {
        if (!active.current) return;
        if (saved) {
          setPlan(saved);
          setPersisted(true);
          setKind(saved.kind);
        }
        setHasAiDraft(Boolean(matching));
      })
      .catch((e) => setError(friendlyError(e)))
      .finally(() => setLoading(false));
    return () => {
      active.current = false;
      paused.current = true;
    };
  }, []);
  const saved = plan ? savedEntryIds(plan) : [];
  const pending = plan?.entries.filter((entry) => entry.state === 'pending').length || 0;
  const existing = plan?.entries.filter((entry) => entry.state === 'existing').length || 0;
  const needsSourceFiles =
    plan?.kind === 'photos' &&
    plan.entries.some(
      (entry) =>
        entry.state === 'pending' && entry.sources?.some((source) => !fileMap.has(fileKey(source))),
    );
  const pageSize = plan?.kind === 'photos' ? 1 : 10;
  const pageCount = Math.max(1, Math.ceil((plan?.entries.length || 0) / pageSize));
  const baseCount = useMemo(() => {
    try {
      return numberCount(baseSelection(checklist, ownership, numbers).owned);
    } catch {
      return null;
    }
  }, [checklist, ownership, numbers]);
  async function preview() {
    setError('');
    setBusy(true);
    paused.current = false;
    try {
      const entries: BulkEntryPlan['entries'] = [];
      if (kind === 'photos') {
        if (!files.length) throw new Error('Choose front and back photos first.');
        for (const pair of pairPhotos(files, order))
          entries.push({
            card: bulkCard(common, {}),
            sources: pair.map(fileReference) as [FileReference, FileReference],
            state: 'pending',
          });
        setSummary(
          `${files.length} photos, ${entries.length} cards. Check each front/back pair before saving.`,
        );
      } else if (kind === 'manual') {
        for (const row of manualRows(rows))
          entries.push({ card: bulkCard(common, row), state: 'pending' });
        if (!entries.length) throw new Error('Enter at least one card.');
        setSummary(`${entries.length} cards. No photos or AI are needed.`);
      } else {
        if (
          !common.category?.trim() ||
          !common.maker?.trim() ||
          !common.year?.trim() ||
          !common.set?.trim()
        )
          throw new Error(
            'Enter the category, maker, year and set so base cards are matched to the correct set.',
          );
        const selected = baseSelection(checklist, ownership, numbers);
        const count = numberCount(selected.owned);
        if (!count) throw new Error('No owned base cards were selected.');
        for (const number of cardNumbers(selected.owned)) {
          if (paused.current) return;
          entries.push({ card: bulkCard(common, { cardNumber: number }, true), state: 'pending' });
          if (entries.length % 200 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
        }
        const unrecorded = selected.unrecorded ? numberCount(selected.unrecorded) : null;
        const remainingNumbers = selected.unrecorded
          ?.map(([a, b]) => (a === b ? String(a) : `${a}-${b}`))
          .join(', ');
        setSummary(
          `${common.year} ${common.maker} ${common.set}: ${count} owned base cards. ${
            unrecorded === null
              ? 'The remaining checklist is unknown.'
              : `${unrecorded} ${ownership === 'owned' ? 'numbers not yet recorded' : unrecorded === 1 ? 'missing card' : 'missing cards'}${remainingNumbers ? `: ${remainingNumbers}` : ''}.`
          }`,
        );
      }
      setPlan({ id: crypto.randomUUID(), kind, entries });
      setPersisted(false);
      setPage(0);
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setBusy(false);
      if (closeAfter.current) onClose();
    }
  }
  async function save(identify = false) {
    if (!plan) return;
    setBusy(true);
    setError('');
    paused.current = false;
    let current = plan;
    try {
      if (!persisted) {
        await db.transaction('rw', db.settings, async () => {
          const previous = await getBulkEntryPlan();
          if (previous && previous.id !== plan.id)
            throw new Error(
              'Another import is waiting in this browser. Close and reopen Bulk add to resume it.',
            );
          await storeBulkEntryPlan(current);
        });
        setPersisted(true);
      }
      for (let index = 0; index < current.entries.length; index++) {
        if (paused.current || !active.current) break;
        if (current.entries[index].state !== 'pending') continue;
        try {
          current = await saveBulkEntry(current, index, fileMap);
        } catch (e) {
          setPage(Math.floor(index / pageSize));
          throw e;
        }
        if (active.current) setPlan(current);
      }
      if (identify && active.current && !current.entries.some((entry) => entry.state === 'pending'))
        await finish(true, current);
    } catch (e) {
      if (active.current)
        setError(
          friendlyError(e) +
            ' Saved cards are kept. Resume after fixing the problem, or skip this card.',
        );
    } finally {
      if (active.current) setBusy(false);
      if (closeAfter.current) onClose();
    }
  }
  async function updateEntry(index: number, action: 'swap' | 'skip') {
    if (!plan || busy) return;
    const next = {
      ...plan,
      entries: plan.entries.map((entry, i) => {
        if (i !== index || entry.state !== 'pending') return entry;
        return action === 'skip'
          ? { ...entry, state: 'skipped' as const }
          : {
              ...entry,
              sources: entry.sources
                ? ([entry.sources[1], entry.sources[0]] as [FileReference, FileReference])
                : undefined,
            };
      }),
    };
    try {
      setPlan(persisted ? await changeBulkEntry(plan.id, index, action) : next);
      setError('');
    } catch (e) {
      setError(friendlyError(e));
    }
  }
  async function finish(identify: boolean, completedPlan?: BulkEntryPlan) {
    const finished = completedPlan ?? plan;
    if (!finished || (busy && !completedPlan)) return;
    try {
      let ids = savedEntryIds(finished);
      if (persisted || completedPlan)
        await db.transaction('rw', db.settings, async () => {
          const latest = await getBulkEntryPlan();
          if (latest?.id !== finished.id)
            throw new Error('This import changed in another tab. Reopen Bulk add.');
          ids = savedEntryIds(latest);
          await deleteBulkEntryPlan(finished.id);
        });
      onSaved(ids, identify);
    } catch (e) {
      setError(friendlyError(e));
    }
  }
  async function useAiPairs(pairs: [FileReference, FileReference][], job: PhotoMatchingJob) {
    const retained = plan?.identifyAfterSaving ? plan.entries : [];
    const retainedKeys = new Set(retained.flatMap((entry) => entry.sources?.map(fileKey) ?? []));
    if (pairs.some((pair) => pair.some((source) => retainedKeys.has(fileKey(source)))))
      throw new Error('These photos are already in this import. Review their existing pairs.');
    const next: BulkEntryPlan = {
      id: plan?.id ?? crypto.randomUUID(),
      kind: 'photos',
      identifyAfterSaving: true,
      entries: [
        ...retained,
        ...pairs.map((sources) => ({
          card: bulkCard(plan?.entries[0]?.card.fields ?? common, {}),
          sources,
          state: 'pending' as const,
        })),
      ],
    };
    await db.transaction('rw', db.settings, async () => {
      const previous = await getBulkEntryPlan();
      if (
        previous &&
        (previous.id !== plan?.id ||
          previous.entries.some((entry) => entry.state === 'saved' || entry.state === 'existing') ||
          JSON.stringify(previous) !== JSON.stringify(plan))
      )
        throw new Error(
          'This import changed in another tab. Reopen Bulk add before replacing its pairs.',
        );
      await storeBulkEntryPlan(next);
      await consumePhotoMatchingPairs(job.id, pairs);
    });
    setPlan(next);
    setPersisted(true);
    setPage(0);
    setAiMode(false);
    setError('');
    const remaining = job.files.length - pairs.length * 2;
    setHasAiDraft(remaining > 0);
    setSummary(
      `${next.entries.length} reviewed pairs. ${remaining ? `${remaining} unmatched ${remaining === 1 ? 'photo remains' : 'photos remain'} in the AI matching draft.` : 'Save these cards to continue to identification.'}`,
    );
  }
  function close() {
    if (busy) {
      paused.current = true;
      closeAfter.current = true;
    } else onClose();
  }
  const chooseFiles = (
    <label className="bulk-file-input">
      {plan ? 'Reselect source photos to resume' : 'Front and back photos'}
      <input
        type="file"
        accept="image/*,.heic,.heif"
        multiple
        disabled={busy}
        onChange={(event) => {
          const selected = Array.from(event.target.files || []);
          if (selected.length) {
            try {
              validateSourceFiles(selected);
              setFiles(selected);
              setError('');
            } catch (e) {
              setError(friendlyError(e));
            }
          }
        }}
      />
    </label>
  );
  return (
    <Modal title="Bulk add" onClose={close} wide>
      <div className="bulk-add">
        {aiMode ? (
          <AiPhotoMatch
            files={files}
            sources={
              plan
                ? plan.entries
                    .filter((entry) => entry.state === 'pending')
                    .flatMap((entry) => entry.sources ?? [])
                : files.map(fileReference)
            }
            onFiles={setFiles}
            onBack={() => {
              setAiMode(false);
              void getPhotoMatchingJob().then((job) => setHasAiDraft(Boolean(job)));
            }}
            onUsePairs={useAiPairs}
          />
        ) : loading ? (
          <p>Loading saved import…</p>
        ) : !plan ? (
          <>
            <label>
              Entry method
              <select
                value={kind}
                disabled={busy}
                onChange={(e) => {
                  setKind(e.target.value as BulkEntryPlan['kind']);
                  setError('');
                }}
              >
                <option value="photos">Photos</option>
                <option value="manual">Manual list</option>
                <option value="base">Base set</option>
              </select>
            </label>
            <fieldset disabled={busy} className="bulk-common">
              <legend>Shared card details</legend>
              <div className="form-grid">
                {(['category', 'product', 'maker', 'set', 'year'] as Field[]).map((field) => (
                  <label key={field}>
                    {fieldLabels[field]}
                    <input
                      value={common[field] || ''}
                      maxLength={300}
                      list={
                        field === 'category'
                          ? 'bulk-categories'
                          : field === 'product'
                            ? 'bulk-products'
                            : undefined
                      }
                      onChange={(e) =>
                        setCommon((previous) => ({ ...previous, [field]: e.target.value }))
                      }
                    />
                  </label>
                ))}
              </div>
              <datalist id="bulk-categories">
                {categories.map((value) => (
                  <option value={value} key={value} />
                ))}
              </datalist>
              <datalist id="bulk-products">
                {products.map((value) => (
                  <option value={value} key={value} />
                ))}
              </datalist>
            </fieldset>
            {kind === 'photos' ? (
              <>
                {chooseFiles}
                <p className="small muted">
                  No photo-count cap. Photos are sorted by filename and saved one pair at a time.
                  Device storage still applies.
                </p>
                <label>
                  Photo order
                  <select
                    value={order}
                    disabled={busy}
                    onChange={(e) => setOrder(e.target.value as PairOrder)}
                  >
                    <option value="alternating">Front, back, front, back</option>
                    <option value="fronts-first">
                      All fronts, then all backs in matching order
                    </option>
                  </select>
                </label>
                <p>{files.length} photos selected</p>
              </>
            ) : kind === 'manual' ? (
              <>
                <label>
                  Cards, one per line
                  <textarea
                    rows={7}
                    disabled={busy}
                    value={rows}
                    onChange={(e) => setRows(e.target.value)}
                    placeholder={
                      'Player or character | Card number | Team | Rarity\nExample player | 12 | Example team | Base'
                    }
                  />
                </label>
                <p className="small muted">
                  Separate columns with a tab or |. Only a name or card number is required. Each
                  line creates one physical card.
                </p>
              </>
            ) : (
              <>
                <p className="notice">
                  Base cards only. Parallels, autographs, relics and serial-numbered cards are not
                  included.
                </p>
                <label>
                  Base checklist numbers
                  <input
                    disabled={busy}
                    value={checklist}
                    onChange={(e) => setChecklist(e.target.value)}
                    placeholder="For example: 1-350"
                  />
                </label>
                <label>
                  Ownership
                  <select
                    disabled={busy}
                    value={ownership}
                    onChange={(e) => setOwnership(e.target.value as OwnershipMode)}
                  >
                    <option value="complete">I own the complete base set</option>
                    <option value="missing">I own all except these missing numbers</option>
                    <option value="owned">I can confirm only these owned numbers</option>
                  </select>
                </label>
                {ownership !== 'complete' && (
                  <label>
                    {ownership === 'missing' ? 'Missing numbers' : 'Confirmed owned numbers'}
                    <textarea
                      disabled={busy}
                      rows={3}
                      value={numbers}
                      onChange={(e) => setNumbers(e.target.value)}
                      placeholder="For example: 2, 7, 147 or 1-25"
                    />
                  </label>
                )}
                <p className="small muted">
                  {ownership === 'owned'
                    ? 'Leave the checklist blank if its range is unknown. Unrecorded numbers may still be in your collection.'
                    : 'Use the base checklist for this exact set and year. Existing owned base cards are skipped.'}
                </p>
                {baseCount !== null && (
                  <p role="status">
                    {baseCount.toLocaleString()} owned base cards will be prepared for review.
                  </p>
                )}
              </>
            )}
            <div className="button-row">
              <button className="primary" disabled={busy} onClick={() => void preview()}>
                {busy ? 'Preparing…' : 'Review import'}
              </button>
              {kind === 'photos' && (
                <button
                  disabled={busy || (!files.length && !hasAiDraft)}
                  onClick={() => setAiMode(true)}
                >
                  {hasAiDraft ? 'Resume AI photo matching' : 'Match and identify with AI'}
                </button>
              )}
              {busy && (
                <button
                  onClick={() => {
                    paused.current = true;
                  }}
                >
                  Stop preparing
                </button>
              )}
            </div>
          </>
        ) : (
          <>
            {summary && <p>{summary}</p>}
            {plan.kind === 'photos' &&
              saved.length === 0 &&
              existing === 0 &&
              (!plan.identifyAfterSaving || hasAiDraft) && (
                <div className="button-row">
                  <button disabled={busy} onClick={() => setAiMode(true)}>
                    {hasAiDraft ? 'Resume AI photo matching' : 'Match and identify with AI'}
                  </button>
                </div>
              )}
            <p role="status">
              {saved.length} saved · {existing} already owned · {pending} left to save
            </p>
            {persisted && pending > 0 && (
              <p className="small muted">
                Progress is saved on this device. Keep this window open to retain selected files, or
                reselect the original photos after reopening.
              </p>
            )}
            {needsSourceFiles && chooseFiles}
            <div className="bulk-review-list">
              {plan.entries.slice(page * pageSize, (page + 1) * pageSize).map((entry, offset) => {
                const index = page * pageSize + offset;
                return (
                  <article className="bulk-review-card" key={entry.card.id}>
                    <div className="bulk-review-title">
                      <strong>
                        Card {index + 1}
                        {entry.card.fields.cardNumber ? ` · #${entry.card.fields.cardNumber}` : ''}
                      </strong>
                      <span>
                        {entry.state === 'existing'
                          ? 'Already owned'
                          : entry.state === 'pending'
                            ? 'Ready'
                            : entry.state}
                      </span>
                    </div>
                    {entry.card.fields.name && <p>{entry.card.fields.name}</p>}
                    {entry.sources && <PairPreview sources={entry.sources} files={fileMap} />}
                    {entry.state === 'pending' && (
                      <div className="button-row">
                        {entry.sources && (
                          <button disabled={busy} onClick={() => void updateEntry(index, 'swap')}>
                            Swap front and back
                          </button>
                        )}
                        <button disabled={busy} onClick={() => void updateEntry(index, 'skip')}>
                          Skip card {index + 1}
                        </button>
                      </div>
                    )}
                  </article>
                );
              })}
            </div>
            <nav className="bulk-pagination" aria-label="Import preview pages">
              <button disabled={page <= 0} onClick={() => setPage((n) => n - 1)}>
                Previous
              </button>
              <span>
                Page {page + 1} of {pageCount}
              </span>
              <button disabled={page >= pageCount - 1} onClick={() => setPage((n) => n + 1)}>
                Next
              </button>
            </nav>
            {error && (
              <p className="notice warning" role="alert">
                {error}
              </p>
            )}
            <div className="modal-footer">
              {!persisted && !busy && (
                <button
                  onClick={() => {
                    setPlan(null);
                    setError('');
                  }}
                >
                  Edit import
                </button>
              )}
              {busy ? (
                <button
                  onClick={() => {
                    paused.current = true;
                  }}
                >
                  Pause after this card
                </button>
              ) : pending > 0 ? (
                <button
                  className="primary"
                  onClick={() => void save(Boolean(plan.identifyAfterSaving))}
                >
                  {plan.identifyAfterSaving
                    ? `Save and identify ${pending} cards`
                    : persisted
                      ? 'Resume saving'
                      : `Save ${pending} cards`}
                </button>
              ) : (
                <button className="primary" onClick={() => void finish(false)}>
                  Finish import
                </button>
              )}
              {!busy && persisted && pending > 0 && (
                <>
                  <button onClick={onClose}>Close and resume later</button>
                  <button onClick={() => void finish(false)}>
                    End import and keep saved cards
                  </button>
                </>
              )}
              {!busy && !pending && plan.kind === 'photos' && saved.length > 0 && (
                <button className="primary" onClick={() => void finish(true)}>
                  Identify saved cards
                </button>
              )}
            </div>
          </>
        )}
        {error && !plan && (
          <p className="notice warning" role="alert">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}
