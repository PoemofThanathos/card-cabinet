import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { newCard, purgedCard, type Card, type Operation, type RemoteCard } from '../src/model';
import type { CloudStore } from '../src/sync';

const store = vi.hoisted(() => ({
  remote: undefined as RemoteCard | undefined,
  writes: [] as RemoteCard[],
}));
vi.mock('firebase/app', () => ({ initializeApp: () => ({}) }));
vi.mock('firebase/auth', () => ({
  getAuth: () => ({}),
  browserLocalPersistence: {},
  setPersistence: vi.fn(),
  signInWithEmailAndPassword: vi.fn(),
  signOut: vi.fn(),
  onAuthStateChanged: vi.fn(),
}));
vi.mock('firebase/firestore', () => ({
  getFirestore: () => ({}),
  doc: () => ({}),
  runTransaction: async (_fs: unknown, action: (tx: unknown) => Promise<unknown>) =>
    action({
      get: async () => ({
        exists: () => !!store.remote,
        data: () => structuredClone(store.remote),
      }),
      set: (_ref: unknown, value: RemoteCard) => {
        store.writes.push(structuredClone(value));
        store.remote = structuredClone(value);
      },
    }),
  collection: vi.fn(),
  getDocsFromServer: vi.fn(),
  query: vi.fn(),
  orderBy: vi.fn(),
  limit: vi.fn(),
  startAfter: vi.fn(),
}));

let cloud: CloudStore;
beforeEach(async () => {
  store.remote = undefined;
  store.writes = [];
  vi.stubEnv('VITE_FIREBASE_API_KEY', 'test-public-config');
  vi.stubEnv('VITE_FIREBASE_PROJECT_ID', 'demo-card-cabinet');
  vi.stubEnv('VITE_FIREBASE_APP_ID', 'test-app');
  cloud = (await import('../src/firebase')).cloudStore('owner');
});
afterEach(() => vi.unstubAllEnvs());
const operation = (card: Card, baseRev: number): Operation => ({
  id: card.id,
  card,
  baseRev,
  mutationId: crypto.randomUUID(),
  version: 2,
});

it('commits a purge against the current cloud revision despite a stale device revision', async () => {
  const card = newCard();
  card.fields.name = 'Concurrent cloud edit';
  store.remote = { rev: 9, mutationId: crypto.randomUUID(), card };
  const result = await cloud.commit(operation(purgedCard(card), 1));
  expect(result.ok).toBe(true);
  expect(result.remote.rev).toBe(10);
  expect(result.remote.card.status).toBe('purged');
  expect(store.writes).toHaveLength(1);
});

it('returns a remote purge without writing any stale restore or edit', async () => {
  const card = newCard();
  const deleted = { rev: 4, mutationId: crypto.randomUUID(), card: purgedCard(card) };
  store.remote = deleted;
  const result = await cloud.commit(operation(card, 4));
  expect(result).toEqual({ ok: false, remote: deleted });
  expect(store.writes).toEqual([]);
});

it('acknowledges an already purged record without creating a new revision', async () => {
  const card = purgedCard(newCard());
  store.remote = { rev: 4, mutationId: crypto.randomUUID(), card };
  const result = await cloud.commit(operation(card, 1));
  expect(result.ok).toBe(true);
  expect(result.remote.rev).toBe(4);
  expect(store.writes).toEqual([]);
});

it('still reports ordinary concurrent edits as conflicts', async () => {
  const card = newCard();
  store.remote = { rev: 4, mutationId: crypto.randomUUID(), card };
  const edit = { ...card, fields: { ...card.fields, name: 'Offline edit' } };
  expect((await cloud.commit(operation(edit, 1))).ok).toBe(false);
  expect(store.writes).toEqual([]);
});
