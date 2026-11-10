import { useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useRegisterSW } from 'virtual:pwa-register/react';
import { type User } from 'firebase/auth';
import {
  BookOpen,
  Plus,
  Search,
  LayoutGrid,
  List,
  Settings as SettingsIcon,
  Archive,
  Trash2,
  Download,
  Cloud,
  HardDrive,
  Copy,
  Pencil,
  ArrowUpRight,
  RotateCcw,
  X,
  WifiOff,
  CheckCircle2,
  RefreshCw,
  Users,
  ArrowLeft,
} from 'lucide-react';
import { db, changeStatus, duplicateCard, friendlyError, setting } from './db';
import {
  type Card,
  type LocalCard,
  type Draft,
  newCard,
  plainCard,
  matchCard,
  title,
  fieldLabels,
  fields,
} from './model';
import { auth, onAuthStateChanged, cloudStore } from './firebase';
import { syncCollection, resolveConflict } from './sync';
import { Editor } from './Editor';
import { BatchIdentify } from './BatchIdentify';
import { Backups } from './Backups';
import { Settings } from './Settings';
import { Modal, PhotoView } from './components';
import { exportPackage, download } from './backup';
import { groupCards, groupKey } from './groups';
import { GroupGrid } from './GroupGrid';
import { addSampleCards, sampleCardIds } from './samples';

function CardStatus({
  card,
  hashes,
  conflicted,
}: {
  card: LocalCard;
  hashes: Set<string>;
  conflicted: boolean;
}) {
  const count = Object.values(card.photos).filter((h) => h && hashes.has(h)).length;
  return (
    <div className="card-status">
      <span title="Saved on this device">
        <HardDrive size={12} />
        Saved here
      </span>
      <span className={conflicted ? 'warn' : ''}>
        <Cloud size={12} />
        {conflicted
          ? 'Conflict'
          : card.syncedVersion === card.localVersion && card.baseRev > 0
            ? 'Synced'
            : 'Not synced'}
      </span>
      <span className={count < 2 ? 'muted' : ''}>{count}/2 photos here</span>
    </div>
  );
}
export default function App() {
  const cards = useLiveQuery(() => db.cards.toArray(), []) || [],
    photos = useLiveQuery(() => db.photos.toCollection().primaryKeys(), []) || [],
    conflicts = useLiveQuery(() => db.conflicts.toArray(), []) || [],
    queue = useLiveQuery(() => db.queue.count(), []) || 0;
  const draft = useLiveQuery(() => setting<Draft | null>('draft', null), []);
  const hashes = new Set(photos),
    conflictIds = new Set(conflicts.map((c) => c.id));
  const [page, setPage] = useState<'collection' | 'all' | 'players' | 'backups' | 'settings'>(
      'collection',
    ),
    [openGroup, setOpenGroup] = useState<string | null>(null),
    [status, setStatus] = useState<Card['status']>('active'),
    [search, setSearch] = useState(''),
    [category, setCategory] = useState(''),
    [maker, setMaker] = useState(''),
    [year, setYear] = useState(''),
    [missing, setMissing] = useState(false),
    [view, setView] = useState<'grid' | 'list'>('grid'),
    [sort, setSort] = useState('recent');
  const [editor, setEditor] = useState<Draft | null>(null),
    [detail, setDetail] = useState<string | null>(null),
    [user, setUser] = useState<User | null>(auth?.currentUser || null),
    [syncing, setSyncing] = useState(false),
    [busy, setBusy] = useState(false),
    [backupBusy, setBackupBusy] = useState(false),
    [notice, setNotice] = useState(''),
    [error, setError] = useState(''),
    [online, setOnline] = useState(navigator.onLine),
    [conflictOpen, setConflictOpen] = useState(false),
    [selectedIds, setSelectedIds] = useState<string[]>([]),
    [batch, setBatch] = useState<Card[] | null>(null);
  const {
    offlineReady: [offlineReady, setOfflineReady],
    needRefresh: [needRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisterError: () =>
      setError(
        'Offline installation could not finish. Reload while online and check your browser storage.',
      ),
  });
  useEffect(() => {
    if (!auth) return;
    return onAuthStateChanged(auth, setUser);
  }, []);
  useEffect(() => {
    const on = () => setOnline(navigator.onLine);
    window.addEventListener('online', on);
    window.addEventListener('offline', on);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', on);
    };
  }, []);
  async function run(action: () => Promise<unknown>, message = '') {
    setBusy(true);
    try {
      await action();
      if (message) setNotice(message);
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setBusy(false);
    }
  }
  async function sync() {
    if (!user) {
      setPage('settings');
      return;
    }
    setSyncing(true);
    try {
      const action = () => syncCollection(cloudStore(user.uid), user.uid);
      if (navigator.locks) await navigator.locks.request('card-cabinet-sync', action);
      else await action();
      setNotice('Metadata sync finished. Photos remain on their original devices.');
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setSyncing(false);
    }
  }
  function openNew() {
    if (draft) {
      setEditor(draft);
      setNotice('Resumed your saved draft. Save it or discard it before starting another card.');
    } else setEditor({ card: newCard(), base: null });
  }
  function edit(card: Card) {
    if (draft && !confirm('Replace the saved draft with this card?')) return;
    setDetail(null);
    setEditor({ card: plainCard(card), base: plainCard(card) });
  }
  const groupKind = page === 'players' ? 'player' : 'set';
  const isLibrary = page === 'collection' || page === 'all' || page === 'players';
  const grouped = status === 'active' && (page === 'collection' || page === 'players');
  const group =
    grouped && openGroup
      ? groupCards(
          cards.filter((c) => c.status === 'active'),
          groupKind,
        ).find((g) => g.key === openGroup)
      : undefined;
  const filtered = cards
    .filter(
      (c) =>
        c.status === status &&
        (!grouped || !openGroup || groupKey(c, groupKind) === openGroup) &&
        matchCard(c, search) &&
        (!category || c.fields.category === category) &&
        (!maker || c.fields.maker === maker) &&
        (!year || c.fields.year === year) &&
        (!missing || Object.values(c.photos).some((h) => !h || !hashes.has(h))),
    )
    .sort((a, b) =>
      sort === 'name'
        ? title(a).localeCompare(title(b))
        : sort === 'year'
          ? b.fields.year.localeCompare(a.fields.year)
          : b.updatedAt.localeCompare(a.updatedAt),
    );
  const active = cards.filter((c) => c.status === 'active'),
    selected = cards.find((c) => c.id === detail);
  const totalPhotos = cards.reduce(
    (n, c) => n + Object.values(c.photos).filter((h) => h && hashes.has(h)).length,
    0,
  );
  const nav = (p: typeof page, s: Card['status'] = 'active') => {
    setPage(p);
    setStatus(s);
    setOpenGroup(null);
    setSearch('');
    setCategory('');
    setMaker('');
    setYear('');
    setMissing(false);
    setSelectedIds([]);
  };
  const groups = groupCards(filtered, groupKind, sort);
  const showingGroups = grouped && !openGroup;
  const listView = status === 'active' ? 'list' : view;
  const testCardsAdded = sampleCardIds.every((id) => cards.some((card) => card.id === id));
  const allBusy = busy || backupBusy || syncing || !!editor || !!batch;
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a
          className="brand"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            nav('collection');
          }}
        >
          <span className="brand-mark">
            <BookOpen size={24} />
          </span>
          <span>Card Cabinet</span>
        </a>
        <nav>
          <button
            className={
              page === 'collection' && status === 'active' ? 'nav-item current' : 'nav-item'
            }
            onClick={() => nav('collection')}
          >
            <BookOpen size={19} />
            Collection<span>{active.length}</span>
          </button>
          <button
            className={page === 'all' ? 'nav-item current' : 'nav-item'}
            onClick={() => nav('all')}
          >
            <List size={19} />
            All cards<span>{active.length}</span>
          </button>
          <button
            className={page === 'players' ? 'nav-item current' : 'nav-item'}
            onClick={() => nav('players')}
          >
            <Users size={19} />
            Players<span>{groupCards(active, 'player').length}</span>
          </button>
          <button
            className={
              page === 'collection' && status === 'archived' ? 'nav-item current' : 'nav-item'
            }
            onClick={() => nav('collection', 'archived')}
          >
            <Archive size={19} />
            Archived<span>{cards.filter((c) => c.status === 'archived').length}</span>
          </button>
          <button
            className={
              page === 'collection' && status === 'deleted' ? 'nav-item current' : 'nav-item'
            }
            onClick={() => nav('collection', 'deleted')}
          >
            <Trash2 size={19} />
            Recently deleted<span>{cards.filter((c) => c.status === 'deleted').length}</span>
          </button>
          <div className="nav-divider" />
          <button
            className={page === 'backups' ? 'nav-item current' : 'nav-item'}
            onClick={() => nav('backups')}
          >
            <Download size={19} />
            Backups & transfer
          </button>
          <button
            className={page === 'settings' ? 'nav-item current' : 'nav-item'}
            onClick={() => nav('settings')}
          >
            <SettingsIcon size={19} />
            Settings
          </button>
        </nav>
        <div className="sidebar-bottom">
          <div className="local-dot" />
          {online ? 'Local storage' : 'Offline'}
          <p>
            Photos stay on this device.
            <br />
            Export a backup to transfer them.
          </p>
          <button onClick={() => nav('backups')}>
            Backups <ArrowUpRight size={15} />
          </button>
        </div>
      </aside>
      <div className="main-column">
        <header className="topbar">
          <div className="topbar-actions">
            <span className="connection">
              {online ? <span className="local-dot" /> : <WifiOff size={15} />}{' '}
              {online ? 'Local first' : 'Offline'}
            </span>
            <button
              className="sync-button"
              disabled={syncing || !online}
              onClick={() => void sync()}
            >
              <RefreshCw size={15} className={syncing ? 'spinning' : ''} />
              {syncing ? 'Syncing' : queue ? 'Sync · ' + queue : 'Sync'}
            </button>
          </div>
        </header>
        <main>
          <div className="alerts">
            {error && (
              <div className="alert error" role="alert">
                <span>{error}</span>
                <button aria-label="Dismiss error" onClick={() => setError('')}>
                  <X size={17} />
                </button>
              </div>
            )}
            {notice && (
              <div className="alert" role="status">
                <span>{notice}</span>
                <button aria-label="Dismiss notification" onClick={() => setNotice('')}>
                  <X size={17} />
                </button>
              </div>
            )}
            {offlineReady && (
              <div className="alert">
                <span>
                  <CheckCircle2 size={16} />
                  Ready for offline use. Keep a backup of your photos.
                </span>
                <button onClick={() => setOfflineReady(false)} aria-label="Dismiss offline ready">
                  <X size={16} />
                </button>
              </div>
            )}
            {needRefresh && (
              <div className="alert">
                <span>An app update is ready. Finish editing and close other app tabs first.</span>
                <button
                  disabled={allBusy}
                  onClick={() => {
                    if (
                      confirm(
                        'Apply the update now? Save and close any other Card Cabinet tabs first.',
                      )
                    )
                      void updateServiceWorker(true);
                  }}
                >
                  Update now
                </button>
              </div>
            )}
            {conflicts.length > 0 && (
              <div className="alert warning">
                <span>
                  {conflicts.length} sync{' '}
                  {conflicts.length === 1 ? 'conflict needs' : 'conflicts need'} your review. Both
                  versions are kept.
                </span>
                <button onClick={() => setConflictOpen(true)}>Review conflicts</button>
              </div>
            )}
          </div>
          {isLibrary ? (
            <>
              {grouped && openGroup && (
                <button
                  className="group-back text-button"
                  onClick={() => {
                    setOpenGroup(null);
                    setSelectedIds([]);
                  }}
                >
                  <ArrowLeft size={16} />
                  {page === 'players' ? 'All players' : 'All sets'}
                </button>
              )}
              <div className="page-heading">
                <div>
                  <h1>
                    {status === 'active'
                      ? grouped && openGroup
                        ? group?.name || (page === 'players' ? 'Player cards' : 'Set cards')
                        : page === 'all'
                          ? 'All cards'
                          : page === 'players'
                            ? 'Players'
                            : 'Your collection'
                      : status === 'archived'
                        ? 'Archived cards'
                        : 'Recently deleted'}
                  </h1>
                  {group?.detail && <p className="group-detail">{group.detail}</p>}
                  {status === 'deleted' && (
                    <p>Deleted cards remain recoverable and are included in backups.</p>
                  )}
                </div>
                <div className="button-row heading-actions">
                  {!testCardsAdded && (
                    <button
                      disabled={allBusy}
                      onClick={() =>
                        void run(async () => {
                          const count = await addSampleCards();
                          setNotice(
                            `${count} test cards added. Their artwork and card details are fictional.`,
                          );
                        })
                      }
                    >
                      Add test cards
                    </button>
                  )}
                  <button className="primary add-button" onClick={openNew}>
                    <Plus size={19} />
                    Add a card
                  </button>
                </div>
              </div>
              {!openGroup && (
                <div className="stats-strip">
                  <div>
                    <span className="stat-label">Physical cards</span>
                    <strong>{active.length.toLocaleString()}</strong>
                  </div>
                  <div>
                    <span className="stat-label">Photos on this device</span>
                    <strong>{totalPhotos.toLocaleString()}</strong>
                  </div>
                  <div>
                    <span className="stat-label">Metadata to sync</span>
                    <strong>{queue.toLocaleString()}</strong>
                  </div>
                </div>
              )}
              {draft && !editor && (
                <div className="draft-bar">
                  <span>You have a saved card draft.</span>
                  <button onClick={() => setEditor(draft)}>Resume draft</button>
                  <button
                    onClick={() => {
                      if (
                        confirm(
                          'Discard this unsaved card draft? Your saved collection will remain.',
                        )
                      )
                        void db.settings.delete('draft');
                    }}
                  >
                    Discard
                  </button>
                </div>
              )}
              <div className="collection-toolbar">
                <label className="search">
                  <Search size={18} />
                  <input
                    aria-label="Search collection"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search names, sets, numbers, notes…"
                  />
                  {search && (
                    <button aria-label="Clear search" onClick={() => setSearch('')}>
                      <X size={15} />
                    </button>
                  )}
                </label>
                <select
                  aria-label="Filter category"
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                >
                  <option value="">All categories</option>
                  {[...new Set(cards.map((c) => c.fields.category).filter(Boolean))]
                    .sort()
                    .map((v) => (
                      <option key={v}>{v}</option>
                    ))}
                </select>
                <select
                  aria-label="Sort cards"
                  value={sort}
                  onChange={(e) => setSort(e.target.value)}
                >
                  <option value="recent">Recently updated</option>
                  <option value="name">Name A to Z</option>
                  <option value="year">Year, newest first</option>
                </select>
                {status !== 'active' && (
                  <div className="view-toggle">
                    <button
                      aria-label="Grid view"
                      aria-pressed={view === 'grid'}
                      className={view === 'grid' ? 'chosen' : ''}
                      onClick={() => setView('grid')}
                    >
                      <LayoutGrid size={18} />
                    </button>
                    <button
                      aria-label="List view"
                      aria-pressed={view === 'list'}
                      className={view === 'list' ? 'chosen' : ''}
                      onClick={() => setView('list')}
                    >
                      <List size={19} />
                    </button>
                  </div>
                )}
              </div>
              <div className="filter-line">
                {selectedIds.length > 0 && (
                  <button
                    className="secondary"
                    onClick={() =>
                      setBatch(cards.filter((c) => selectedIds.includes(c.id)).map(plainCard))
                    }
                  >
                    Identify selected · {selectedIds.length}
                  </button>
                )}
                <span>
                  {showingGroups &&
                    `${groups.length} ${page === 'players' ? 'players' : 'sets'} · `}
                  {filtered.length} {filtered.length === 1 ? 'card' : 'cards'}
                </span>
                <select
                  aria-label="Filter maker"
                  value={maker}
                  onChange={(e) => setMaker(e.target.value)}
                >
                  <option value="">All makers</option>
                  {[...new Set(cards.map((c) => c.fields.maker).filter(Boolean))]
                    .sort()
                    .map((v) => (
                      <option key={v}>{v}</option>
                    ))}
                </select>
                <select
                  aria-label="Filter year"
                  value={year}
                  onChange={(e) => setYear(e.target.value)}
                >
                  <option value="">All years</option>
                  {[...new Set(cards.map((c) => c.fields.year).filter(Boolean))]
                    .sort()
                    .reverse()
                    .map((v) => (
                      <option key={v}>{v}</option>
                    ))}
                </select>
                <label className="check-label">
                  <input
                    type="checkbox"
                    checked={missing}
                    onChange={(e) => setMissing(e.target.checked)}
                  />
                  Missing photos
                </label>
                <button
                  className="text-button"
                  disabled={!filtered.length || busy}
                  onClick={() =>
                    void run(async () => {
                      const b = await exportPackage(filtered);
                      await download(b, 'card-cabinet-selection.cardcabinet.zip');
                    }, 'Filtered backup handed to your browser. Verify the saved file.')
                  }
                >
                  <Download size={14} />
                  Export these cards
                </button>
              </div>
              {filtered.length ? (
                showingGroups ? (
                  <GroupGrid
                    groups={groups}
                    kind={groupKind}
                    hashes={hashes}
                    onOpen={(key) => {
                      setOpenGroup(key);
                      setSelectedIds([]);
                    }}
                  />
                ) : (
                  <div className={'collection ' + listView} aria-label="Card list">
                    {filtered.map((c) => (
                      <article className="collection-card" key={c.id}>
                        <label className="batch-select">
                          <input
                            type="checkbox"
                            aria-label={'Select ' + title(c) + ' for identification'}
                            checked={selectedIds.includes(c.id)}
                            disabled={!selectedIds.includes(c.id) && selectedIds.length >= 3}
                            onChange={(e) =>
                              setSelectedIds((ids) =>
                                e.target.checked ? [...ids, c.id] : ids.filter((id) => id !== c.id),
                              )
                            }
                          />
                          <span>Select for identification</span>
                        </label>
                        <button
                          className="card-open"
                          onClick={() => setDetail(c.id)}
                          aria-label={'Open ' + title(c)}
                        >
                          <div className="card-image">
                            <PhotoView hash={c.photos.front} alt={'Front of ' + title(c)} />
                            {c.fields.maker && <span className="maker-tag">{c.fields.maker}</span>}
                          </div>
                          <div className="card-copy">
                            <span className="card-category">
                              {c.fields.category || 'Uncategorized'}
                              {c.fields.year ? ' · ' + c.fields.year : ''}
                            </span>
                            <h3>{title(c)}</h3>
                            {c.fields.japaneseName && c.fields.japaneseName !== c.fields.name && (
                              <p lang="ja" className="japanese">
                                {c.fields.japaneseName}
                              </p>
                            )}
                            <p className="card-set">
                              {c.fields.set || 'Set not recorded'}
                              {c.fields.cardNumber ? ' · #' + c.fields.cardNumber : ''}
                            </p>
                            {c.fields.tags
                              .split(',')
                              .map((tag) => tag.trim())
                              .includes('test-card') && (
                              <span className="sample-label">Test card</span>
                            )}
                          </div>
                        </button>
                        <CardStatus card={c} hashes={hashes} conflicted={conflictIds.has(c.id)} />
                      </article>
                    ))}
                  </div>
                )
              ) : (
                <section className="empty-state">
                  <BookOpen size={30} aria-hidden="true" />
                  <div className="empty-copy">
                    <h2>{cards.length ? 'No matching cards' : 'No cards yet'}</h2>
                    {cards.length > 0 && <p>Try another search or filter.</p>}
                    <button className="primary" onClick={openNew}>
                      <Plus size={18} />
                      Add your {cards.length ? 'next' : 'first'} card
                    </button>
                    <span className="small muted">Manual entry works offline.</span>
                  </div>
                </section>
              )}
            </>
          ) : page === 'backups' ? (
            <Backups
              cards={cards}
              onError={setError}
              onMessage={setNotice}
              onBusy={setBackupBusy}
            />
          ) : (
            <Settings
              user={user}
              onError={setError}
              onMessage={setNotice}
              onSync={() => void sync()}
              syncing={syncing}
            />
          )}
        </main>
      </div>
      {batch && (
        <BatchIdentify
          cards={batch}
          onMessage={setNotice}
          onClose={() => {
            setBatch(null);
            setSelectedIds([]);
          }}
        />
      )}
      {editor && (
        <Editor
          key={editor.card.id}
          initial={editor.card}
          base={editor.base}
          onClose={() => setEditor(null)}
          onSaved={() => {
            setEditor(null);
            setNotice('Card saved on this device.');
          }}
          onError={setError}
        />
      )}
      {selected && (
        <Modal title={title(selected)} onClose={() => setDetail(null)} wide>
          <div className="detail-layout">
            <div className="photo-pair">
              {(['front', 'back'] as const).map((side) => (
                <div key={side}>
                  <span className="photo-label">{side}</span>
                  <PhotoView hash={selected.photos[side]} alt={side + ' of ' + title(selected)} />
                </div>
              ))}
            </div>
            <CardStatus card={selected} hashes={hashes} conflicted={conflictIds.has(selected.id)} />
            <dl className="card-fields">
              {fields
                .filter((f) => selected.fields[f])
                .map((f) => (
                  <div key={f}>
                    <dt>{fieldLabels[f]}</dt>
                    <dd>{selected.fields[f]}</dd>
                  </div>
                ))}
            </dl>
            <p className="small muted">Physical copy ID: {selected.id}</p>
            <div className="detail-actions">
              <button className="primary" onClick={() => edit(selected)}>
                <Pencil size={16} />
                Edit card
              </button>
              <button
                onClick={() =>
                  void run(
                    () => duplicateCard(selected),
                    'A separate physical copy was added. It shares the photos until you retake them.',
                  )
                }
              >
                <Copy size={16} />
                Duplicate physical copy
              </button>
              {selected.status === 'active' ? (
                <button onClick={() => void run(() => changeStatus(selected, 'archived'))}>
                  <Archive size={16} />
                  Archive
                </button>
              ) : (
                <button
                  onClick={() =>
                    void run(
                      () => changeStatus(selected, 'active'),
                      'Card restored to your collection.',
                    )
                  }
                >
                  <RotateCcw size={16} />
                  Restore to collection
                </button>
              )}
              {selected.status !== 'deleted' && (
                <button
                  className="danger-text"
                  onClick={() =>
                    void run(async () => {
                      await changeStatus(selected, 'deleted');
                      setDetail(null);
                    }, 'Moved to Recently deleted. You can restore it there.')
                  }
                >
                  <Trash2 size={16} />
                  Delete
                </button>
              )}
            </div>
          </div>
        </Modal>
      )}
      {conflictOpen && (
        <Modal title="Review sync conflicts" onClose={() => setConflictOpen(false)} wide>
          <p>
            Compare the latest local card with the cloud version. Keeping both creates a new
            physical-copy ID for your local version.
          </p>
          {conflicts.length === 0 ? (
            <p>All conflicts resolved. Sync again to send your decisions.</p>
          ) : (
            conflicts.map((c) => {
              const local = cards.find((x) => x.id === c.id) || c.local;
              return (
                <section className="conflict" key={c.id}>
                  <h3>{title(local)}</h3>
                  <div className="compare">
                    <div>
                      <h4>This device</h4>
                      <p>Status: {local.status}</p>
                      <dl>
                        {fields
                          .filter((f) => local.fields[f] !== c.remote.card.fields[f])
                          .map((f) => (
                            <div key={f}>
                              <dt>{fieldLabels[f]}</dt>
                              <dd>{local.fields[f] || 'Blank'}</dd>
                            </div>
                          ))}
                      </dl>
                      <p className="small">
                        Front {local.photos.front?.slice(0, 10) || 'none'} · Back{' '}
                        {local.photos.back?.slice(0, 10) || 'none'}
                      </p>
                    </div>
                    <div>
                      <h4>Cloud revision {c.remote.rev}</h4>
                      <p>Status: {c.remote.card.status}</p>
                      <dl>
                        {fields
                          .filter((f) => local.fields[f] !== c.remote.card.fields[f])
                          .map((f) => (
                            <div key={f}>
                              <dt>{fieldLabels[f]}</dt>
                              <dd>{c.remote.card.fields[f] || 'Blank'}</dd>
                            </div>
                          ))}
                      </dl>
                      <p className="small">
                        Front {c.remote.card.photos.front?.slice(0, 10) || 'none'} · Back{' '}
                        {c.remote.card.photos.back?.slice(0, 10) || 'none'}
                      </p>
                    </div>
                  </div>
                  <div className="button-row">
                    {(['local', 'remote', 'both'] as const).map((choice) => (
                      <button
                        disabled={busy}
                        key={choice}
                        onClick={() => void run(() => resolveConflict(c.id, choice))}
                      >
                        {choice === 'local'
                          ? 'Keep this device'
                          : choice === 'remote'
                            ? 'Use cloud version'
                            : 'Keep both copies'}
                      </button>
                    ))}
                  </div>
                </section>
              );
            })
          )}
        </Modal>
      )}
    </div>
  );
}
