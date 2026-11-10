import { useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { type User } from 'firebase/auth';
import { Cloud, HardDrive, ScanLine, ExternalLink, ShieldCheck } from 'lucide-react';
import { auth, firebaseConfigured, login, signOut } from './firebase';
import { db, setting, setSetting, friendlyError } from './db';

export function Settings({
  user,
  onError,
  onMessage,
  onSync,
  syncing,
}: {
  user: User | null;
  onError: (s: string) => void;
  onMessage: (s: string) => void;
  onSync: () => void;
  syncing: boolean;
}) {
  const [email, setEmail] = useState(''),
    [password, setPassword] = useState(''),
    [busy, setBusy] = useState(false),
    [storage, setStorage] = useState<StorageEstimate | null>(null),
    [persisted, setPersisted] = useState(false),
    [aiEnabled, setAiEnabled] = useState<boolean | null>(null);
  const prefs = useLiveQuery(
    async () => ({
      owner: await setting('ownerUid', ''),
      ai: await setting('aiEnabled', false),
      limit: await setting('aiLimit', 3),
      usage: await setting('aiUsage', { day: '', count: 0 }),
      lastBackup: await setting('lastBackup', ''),
      lastSync: await setting('lastSync', ''),
    }),
    [],
  );
  useEffect(() => {
    if (prefs?.ai === aiEnabled) setAiEnabled(null);
  }, [prefs?.ai, aiEnabled]);
  async function checkStorage() {
    try {
      setStorage((await navigator.storage?.estimate()) || null);
      setPersisted((await navigator.storage?.persisted?.()) || false);
    } catch {
      /* Browser may not expose estimates. */
    }
  }
  useEffect(() => {
    void checkStorage();
  }, []);
  async function signIn() {
    setBusy(true);
    try {
      await login(email, password);
      setPassword('');
    } catch (e) {
      onError(friendlyError(e));
    } finally {
      setBusy(false);
    }
  }
  async function link() {
    if (!user) return;
    if (import.meta.env.VITE_OWNER_UID && user.uid !== import.meta.env.VITE_OWNER_UID) {
      onError('This account is not the configured owner. Sign out and use your personal account.');
      return;
    }
    if (prefs?.owner && prefs.owner !== user.uid) {
      onError(
        'This local collection is already linked to another UID. Use a separate browser profile for another account.',
      );
      return;
    }
    if (
      !confirm(
        'Link this local collection to UID ' +
          user.uid +
          '? Sync will upload all card metadata, including notes and purchase details, to your private Firestore path. Photos stay local.',
      )
    )
      return;
    await setSetting('ownerUid', user.uid);
    onMessage('This device is linked. Use Sync now to exchange metadata.');
  }
  const today = new Date().toISOString().slice(0, 10);
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>Settings</h1>
        </div>
      </div>
      <div className="settings-grid">
        <section className="panel">
          <Cloud size={25} />
          <h2>Metadata sync</h2>
          {!firebaseConfigured ? (
            <div className="notice">
              <strong>Firebase is not configured yet.</strong>
              <p>
                The app works locally now. Follow the included README to create a Spark project,
                enable email/password login, and add the public configuration.
              </p>
            </div>
          ) : user ? (
            <>
              <p>
                Signed in as <strong>{user.email || user.uid}</strong>
              </p>
              <label>
                Your Firebase UID
                <input readOnly value={user.uid} />
              </label>
              <p className="small muted">
                {prefs?.owner === user.uid
                  ? 'This collection is linked to this account.'
                  : prefs?.owner
                    ? 'This collection is linked to a different UID.'
                    : 'Link this device before its first sync.'}
              </p>
              <div className="button-row">
                <button
                  disabled={prefs?.owner === user.uid}
                  onClick={() => void link().catch((e) => onError(friendlyError(e)))}
                >
                  Link this collection
                </button>
                <button
                  className="primary"
                  disabled={syncing || prefs?.owner !== user.uid}
                  onClick={onSync}
                >
                  {syncing ? 'Syncing…' : 'Sync now'}
                </button>
                <button
                  onClick={() => {
                    if (auth) void signOut(auth).catch((e) => onError(friendlyError(e)));
                  }}
                >
                  Sign out
                </button>
              </div>
            </>
          ) : (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void signIn();
              }}
            >
              <label>
                Email
                <input
                  type="email"
                  autoComplete="username"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                />
              </label>
              <label>
                Password
                <input
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
              </label>
              <button className="primary" disabled={busy}>
                {busy ? 'Signing in…' : 'Sign in'}
              </button>
              <p className="small muted">
                Create your one personal user in Firebase Authentication. The app has no public
                sign-up.
              </p>
            </form>
          )}
          <hr />
          <p>
            Sync runs when you choose Sync now. It never uploads images. Expired login and quota
            errors leave your local collection available.
          </p>
          <p className="small muted">
            Last complete sync:{' '}
            {prefs?.lastSync ? new Date(prefs.lastSync).toLocaleString() : 'Not yet'}
          </p>
        </section>
        <section className="panel">
          <ScanLine size={25} />
          <h2>Optional identification</h2>
          <label className="check-label">
            <input
              type="checkbox"
              checked={aiEnabled ?? prefs?.ai ?? false}
              disabled={!prefs}
              onChange={(e) => {
                const enabled = e.target.checked;
                setAiEnabled(enabled);
                void setSetting('aiEnabled', enabled)
                  .then(() =>
                    onMessage(
                      enabled
                        ? 'Identification enabled on this device.'
                        : 'Identification disabled on this device.',
                    ),
                  )
                  .catch((err) => {
                    setAiEnabled(null);
                    onError(friendlyError(err));
                  });
              }}
            />
            Enable Identify on this device
          </label>
          <p>
            Identify sends copies of both selected photos to your Worker and OpenAI. Canvas encoding
            removes location metadata. Review the print before sending; compression can make small
            text harder to read.
          </p>
          <label>
            Daily attempt limit on this device
            <select
              value={prefs?.limit || 3}
              onChange={(e) => void setSetting('aiLimit', Number(e.target.value))}
            >
              {[1, 2, 3, 4, 5].map((n) => (
                <option value={n} key={n}>
                  {n} {n === 1 ? 'attempt' : 'attempts'}
                </option>
              ))}
            </select>
          </label>
          <p>
            <strong>{prefs?.usage.day === today ? prefs.usage.count : 0}</strong> attempts today on
            this device, in UTC.
          </p>
          <div className="notice warning">
            OpenAI API use is billed separately from ChatGPT. Device counters and Worker limits do
            not guarantee a billing cap. Failed requests may still be billed. The app cannot read
            your balance.
          </div>
          <p className="small muted">
            The Worker must also be enabled by its owner. It limits all devices together to 5
            attempts per UTC day and 50 per UTC month. No OpenAI key belongs in this app.
          </p>
          <a
            href="https://platform.openai.com/settings/organization/billing/overview"
            target="_blank"
            rel="noreferrer"
          >
            OpenAI billing settings <ExternalLink size={13} />
          </a>
        </section>
        <section className="panel">
          <HardDrive size={25} />
          <h2>Device storage</h2>
          <p className="storage-number">
            {storage?.usage !== undefined
              ? (storage.usage / 1024 / 1024).toFixed(1) + ' MB'
              : 'Estimate unavailable'}
          </p>
          <p className="small muted">
            {storage?.quota
              ? 'About ' +
                (storage.quota / 1024 / 1024 / 1024).toFixed(1) +
                ' GB browser quota. Quota can change.'
              : 'Your browser does not report a storage quota.'}
          </p>
          <p>
            {persisted
              ? 'The browser reports persistent storage for this site.'
              : 'The browser has not granted persistent storage.'}
          </p>
          <button
            onClick={() => {
              void (async () => {
                if (!navigator.storage?.persist) {
                  onMessage(
                    'This browser does not expose a persistence request. Keep external backups.',
                  );
                  return;
                }
                const granted = await navigator.storage.persist();
                await checkStorage();
                onMessage(
                  granted
                    ? 'Persistence granted. Keep external backups anyway.'
                    : 'Persistence was not granted. The browser decides; keep external backups.',
                );
              })().catch((e) => onError(friendlyError(e)));
            }}
          >
            Request persistent storage
          </button>
          <p className="notice">
            Browser storage can be evicted or erased. Installing to the home screen does not
            guarantee permanence. Never clear this site's data before verifying a backup.
          </p>
          <p className="small muted">
            Last backup handed to browser:{' '}
            {prefs?.lastBackup ? new Date(prefs.lastBackup).toLocaleString() : 'Not yet'}
          </p>
        </section>
        <section className="panel">
          <ShieldCheck size={25} />
          <h2>Install app</h2>
          <ol>
            <li>Open the published HTTPS app URL in Safari on iPhone.</li>
            <li>Use Share, then Add to Home Screen.</li>
            <li>Open it once online and wait for the offline-ready message.</li>
            <li>Try reopening in airplane mode before relying on it.</li>
          </ol>
          <p>
            On Windows, use Edge or Chrome's install button. Use the same HTTPS address each time; a
            different domain or path can have a separate local collection.
          </p>
          <p className="small muted">
            Updates wait for your choice. Finish editing and close other app tabs before applying
            one.
          </p>
        </section>
      </div>
    </>
  );
}
