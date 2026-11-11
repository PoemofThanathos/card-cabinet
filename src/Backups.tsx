import { useEffect, useRef, useState } from 'react';
import { Download, Upload, ArrowRightLeft } from 'lucide-react';
import { type Card, title, fields, fieldLabels } from './model';
import {
  exportPackage,
  csvExport,
  download,
  readPackage,
  planImport,
  applyImport,
  type ImportPackage,
  type ImportRow,
  exportableCards,
  assertExportAvailable,
} from './backup';
import { friendlyError, setSetting } from './db';
import { PhotoTransfer } from './transfer';
import { Modal } from './components';

export function ImportReview({
  pack,
  rows,
  onClose,
  onDone,
  onError,
}: {
  pack: ImportPackage;
  rows: ImportRow[];
  onClose: () => void;
  onDone: () => void;
  onError: (s: string) => void;
}) {
  const [review, setReview] = useState(rows),
    [busy, setBusy] = useState(false),
    [importError, setImportError] = useState('');
  async function run() {
    setBusy(true);
    try {
      await applyImport(pack, review);
      onDone();
    } catch (e) {
      setImportError(friendlyError(e));
      onError(friendlyError(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title="Review backup import"
      onClose={() => {
        if (!busy) onClose();
      }}
      wide
    >
      {importError && (
        <p className="notice warning" role="alert">
          {importError}
        </p>
      )}
      <p>
        {rows.length} cards · {pack.photos.length} verified photos ·{' '}
        {rows.filter((r) => r.kind === 'new').length} new cards
      </p>
      <p className="notice">
        Existing IDs identify physical copies. Repeated imports keep the same copy. Different IDs
        always remain separate.
      </p>
      {pack.missing.length > 0 && (
        <p className="notice warning">
          This package refers to {pack.missing.length} photos it does not contain. Metadata can
          still be restored.
        </p>
      )}
      <div className="import-rows">
        {review.map((row, i) => (
          <div className="import-row" key={row.card.id}>
            <div>
              <strong>{title(row.card)}</strong>
              <span className="small muted">
                {row.card.status} ·{' '}
                {row.kind === 'purged'
                  ? 'Permanently deleted here. Skipped unless imported as a new copy.'
                  : row.kind === 'same'
                    ? 'Already here, photos will be restored'
                    : row.kind === 'new'
                      ? 'New physical copy'
                      : 'Different metadata, review below'}
              </span>
              {row.kind === 'different' && (
                <details>
                  <summary>Compare changes</summary>
                  <dl>
                    {fields
                      .filter((f) => row.existing?.fields[f] !== row.card.fields[f])
                      .map((f) => (
                        <div key={f}>
                          <dt>{fieldLabels[f]}</dt>
                          <dd>
                            Here: {row.existing?.fields[f] || 'blank'}
                            <br />
                            Backup: {row.card.fields[f] || 'blank'}
                          </dd>
                        </div>
                      ))}
                    <div>
                      <dt>Status</dt>
                      <dd>
                        {row.existing?.status} → {row.card.status}
                      </dd>
                    </div>
                    <div>
                      <dt>Photo references</dt>
                      <dd>
                        {JSON.stringify(row.existing?.photos) === JSON.stringify(row.card.photos)
                          ? 'Same photos'
                          : 'Different photos'}
                      </dd>
                    </div>
                  </dl>
                </details>
              )}
            </div>
            {(row.kind === 'different' || row.kind === 'purged') && (
              <select
                aria-label={'Import choice for ' + title(row.card)}
                value={row.choice}
                onChange={(e) =>
                  setReview(
                    review.map((r, j) =>
                      j === i ? { ...r, choice: e.target.value as ImportRow['choice'] } : r,
                    ),
                  )
                }
              >
                <option value="keep">
                  {row.kind === 'purged'
                    ? 'Skip permanently deleted card'
                    : "Keep this device's card"}
                </option>
                {row.kind !== 'purged' && <option value="replace">Use backup's metadata</option>}
                <option value="copy">
                  {row.kind === 'purged' ? 'Import as a new copy' : 'Keep both as separate copies'}
                </option>
              </select>
            )}
          </div>
        ))}
      </div>
      <div className="modal-footer">
        <button onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button className="primary" disabled={busy} onClick={() => void run()}>
          {busy ? 'Importing…' : 'Import reviewed package'}
        </button>
      </div>
    </Modal>
  );
}
export function Backups({
  cards,
  onError,
  onMessage,
  onBusy,
}: {
  cards: Card[];
  onError: (s: string) => void;
  onMessage: (s: string) => void;
  onBusy: (b: boolean) => void;
}) {
  const [pack, setPack] = useState<ImportPackage | null>(null),
    [rows, setRows] = useState<ImportRow[]>([]),
    [ready, setReady] = useState<Blob | null>(null),
    [busy, setBusy] = useState(false),
    [transferOpen, setTransferOpen] = useState(false),
    [code, setCode] = useState(''),
    [joinCode, setJoinCode] = useState(''),
    [status, setStatus] = useState('No connection');
  const transfer = useRef<PhotoTransfer | null>(null);
  const preparedIds = useRef<string[]>([]);
  const preparedVersion = useRef<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const visibleCards = cards.filter((card) => card.status !== 'purged');
  const collectionVersion = cards
    .map((card) => `${card.id}:${card.status}:${card.updatedAt}`)
    .join('|');
  useEffect(() => {
    setReady(null);
    preparedIds.current = [];
    preparedVersion.current = null;
  }, [collectionVersion]);
  useEffect(
    () => () => {
      void transfer.current?.close();
    },
    [],
  );
  useEffect(() => {
    onBusy(busy || !!pack || transferOpen);
    return () => onBusy(false);
  }, [busy, pack, transferOpen]);
  async function prepare() {
    setBusy(true);
    try {
      const selected = await exportableCards(cards);
      const prepared = await exportPackage(selected);
      preparedIds.current = selected.map((card) => card.id);
      preparedVersion.current = collectionVersion;
      setReady(prepared);
      onMessage('Backup prepared. Save or share it below.');
    } catch (e) {
      onError(friendlyError(e));
    } finally {
      setBusy(false);
    }
  }
  async function read(blob: Blob) {
    setBusy(true);
    try {
      const p = await readPackage(blob);
      setRows(await planImport(p));
      setPack(p);
    } catch (e) {
      onError(friendlyError(e));
    } finally {
      setBusy(false);
    }
  }
  async function save(share = false) {
    if (!ready) return;
    try {
      if (preparedVersion.current !== collectionVersion)
        throw new Error(
          'The collection changed. Prepare a new backup before saving or sharing it.',
        );
      // iPhone sharing must reach navigator.share in the original tap, before an IndexedDB await.
      // Preparation checks permanent deletions; collection changes invalidate the prepared file.
      if (!share) await assertExportAvailable(preparedIds.current);
      await download(
        ready,
        'card-cabinet-' + new Date().toISOString().slice(0, 10) + '.cardcabinet.zip',
        share,
      );
      await setSetting('lastBackup', new Date().toISOString());
      onMessage(
        'Backup handed to your browser. Check that the file was saved before removing any local data.',
      );
    } catch (e) {
      if ((e as Error).name !== 'AbortError') onError(friendlyError(e));
    }
  }
  async function saveCsv() {
    try {
      const current = await exportableCards(cards);
      await download(
        new Blob([csvExport(current)], { type: 'text/csv;charset=utf-8' }),
        'card-cabinet.csv',
      );
    } catch (error) {
      onError(friendlyError(error));
    }
  }
  async function pair(join = false) {
    try {
      await transfer.current?.close();
      const t = new PhotoTransfer(setStatus, (b) => {
        void read(b);
      });
      transfer.current = t;
      if (join) {
        await t.join(joinCode);
        setStatus('Waiting for a direct connection…');
      } else {
        setCode(await t.offer());
        setStatus('Enter this code on your other device within 9 minutes.');
      }
    } catch (e) {
      await transfer.current?.close();
      setStatus(friendlyError(e));
      onError(friendlyError(e));
    }
  }
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>Backups & transfer</h1>
        </div>
      </div>
      <div className="two-columns">
        <section className="panel">
          <Download size={26} />
          <h2>Export backup</h2>
          <p>
            Prepare a ZIP with all {visibleCards.length} cards, including archived and recently
            deleted cards, plus the photos stored here. No credentials or app settings are included.
          </p>
          <p className="small muted">
            Up to 200 MB per package. For larger collections, export filtered groups from the
            collection screen.
          </p>
          <button className="primary" disabled={busy} onClick={() => void prepare()}>
            {busy ? 'Preparing…' : 'Prepare full backup'}
          </button>
          {ready && (
            <div className="prepared">
              <strong>Package ready · {(ready.size / 1024 / 1024).toFixed(1)} MB</strong>
              <div className="button-row">
                <button onClick={() => void save()}>
                  <Download size={16} />
                  Save file
                </button>
                <button onClick={() => void save(true)}>Share / Save to Files</button>
              </div>
            </div>
          )}
          <hr />
          <h3>Metadata spreadsheet</h3>
          <p className="small muted">
            CSV includes Unicode text and photo hashes. It does not include photos.
          </p>
          <button onClick={() => void saveCsv()}>Export CSV</button>
        </section>
        <section className="panel">
          <Upload size={26} />
          <h2>Import backup</h2>
          <p>
            Choose a Card Cabinet ZIP. Photos are checked for corruption before you review the
            import.
          </p>
          <button className="secondary" disabled={busy} onClick={() => input.current?.click()}>
            Choose backup package
          </button>
          <input
            type="file"
            hidden
            ref={input}
            accept=".zip,application/zip"
            onChange={(e) => {
              if (e.target.files?.[0]) void read(e.target.files[0]);
              e.target.value = '';
            }}
          />
          <div className="note-box">
            <h3>Backup storage</h3>
            <p>
              Save a copy outside this browser after adding photos. Installation and persistent
              storage do not replace backups.
            </p>
          </div>
        </section>
      </div>
      <section className="panel transfer-panel">
        <ArrowRightLeft size={26} />
        <div>
          <h2>Direct device transfer</h2>
          <p className="small muted">Experimental. Keep both apps open.</p>
          <p>
            Send a prepared package over WebRTC. Both devices sign in to your account. No photos
            pass through Firestore. A direct connection may fail, even on the same Wi-Fi; the ZIP
            file is the supported fallback.
          </p>
        </div>
        <button onClick={() => setTransferOpen(true)}>Open pairing</button>
      </section>
      {transferOpen && (
        <Modal
          title="Direct device transfer"
          onClose={() => {
            void transfer.current?.close();
            setTransferOpen(false);
            setCode('');
          }}
        >
          <p className="notice">
            Keep both apps visible and awake. This proof of concept uses direct network candidates,
            with no TURN relay. iPhone behavior still needs real-device testing.
          </p>
          <p>
            On the sending device, prepare a backup first, then create a pairing. On the receiving
            device, paste the pairing code.
          </p>
          <button onClick={() => void pair()} disabled={!ready}>
            Create pairing as sender
          </button>
          {!ready && (
            <p className="small muted">Close this dialog and prepare a full backup to send.</p>
          )}
          {code && (
            <div className="pair-code">
              <label>
                Temporary pairing code
                <input readOnly value={code} onFocus={(e) => e.target.select()} />
              </label>
            </div>
          )}
          <hr />
          <label>
            Pairing code from the sending device
            <input
              value={joinCode}
              onChange={(e) => setJoinCode(e.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <button onClick={() => void pair(true)}>Join as receiver</button>
          <p className="notice" role="status">
            {status}
          </p>
          <button
            className="primary"
            disabled={!ready || !code}
            onClick={() => {
              if (preparedVersion.current !== collectionVersion) {
                onError('The collection changed. Prepare a new backup before sending it.');
                return;
              }
              if (
                ready &&
                confirm(
                  'Send the prepared backup, including its photos and purchase details, to the paired device?',
                )
              )
                void transfer.current
                  ?.send(ready, preparedIds.current)
                  .catch((e) => onError(friendlyError(e)));
            }}
          >
            Send prepared package
          </button>
        </Modal>
      )}
      {pack && (
        <ImportReview
          pack={pack}
          rows={rows}
          onClose={() => setPack(null)}
          onDone={() => {
            setPack(null);
            onMessage('Import complete. Cards and available photos are saved on this device.');
          }}
          onError={onError}
        />
      )}
    </>
  );
}
