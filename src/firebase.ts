import { initializeApp } from 'firebase/app';
import {
  getAuth,
  browserLocalPersistence,
  setPersistence,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
} from 'firebase/auth';
import {
  getFirestore,
  doc,
  runTransaction,
  collection,
  getDocsFromServer,
  query,
  orderBy,
  limit,
  startAfter,
  type QueryDocumentSnapshot,
  type QueryConstraint,
} from 'firebase/firestore';
import { type CloudStore } from './sync';
import { remoteSchema, sameCard } from './model';

const e = import.meta.env;
export const firebaseConfigured = !!(
  e.VITE_FIREBASE_API_KEY &&
  e.VITE_FIREBASE_PROJECT_ID &&
  e.VITE_FIREBASE_APP_ID
);
const app = firebaseConfigured
  ? initializeApp({
      apiKey: e.VITE_FIREBASE_API_KEY,
      authDomain: e.VITE_FIREBASE_AUTH_DOMAIN,
      projectId: e.VITE_FIREBASE_PROJECT_ID,
      appId: e.VITE_FIREBASE_APP_ID,
    })
  : null;
export const auth = app ? getAuth(app) : null;
export const firestore = app ? getFirestore(app) : null;
export { signOut, onAuthStateChanged };
export async function login(email: string, password: string) {
  if (!auth) throw new Error('Firebase is not configured. Follow the README to enable sync.');
  await setPersistence(auth, browserLocalPersistence);
  await signInWithEmailAndPassword(auth, email, password);
}
export function cloudStore(uid: string): CloudStore {
  if (!firestore) throw new Error('Firebase is not configured.');
  const fs = firestore;
  return {
    async commit(op) {
      const ref = doc(fs, 'users', uid, 'cards', op.id);
      return runTransaction(fs, async (tx) => {
        const snap = await tx.get(ref);
        const remote = snap.exists() ? remoteSchema.parse(snap.data()) : undefined;
        if (remote?.card.status === 'purged') return { ok: op.card.status === 'purged', remote };
        if (remote?.mutationId === op.mutationId || (remote && sameCard(remote.card, op.card)))
          return { ok: true, remote };
        if (op.card.status !== 'purged' && (remote?.rev ?? 0) !== op.baseRev) {
          if (!remote)
            throw new Error(
              'Remote record was removed outside the app. Restore from backup or investigate before syncing.',
            );
          return { ok: false, remote };
        }
        const next = { rev: (remote?.rev ?? 0) + 1, mutationId: op.mutationId, card: op.card };
        tx.set(ref, next);
        return { ok: true, remote: next };
      });
    },
    async *list() {
      let cursor: QueryDocumentSnapshot | undefined;
      while (true) {
        const constraints: QueryConstraint[] = [orderBy('__name__'), limit(200)];
        if (cursor) constraints.push(startAfter(cursor));
        const page = await getDocsFromServer(
          query(collection(fs, 'users', uid, 'cards'), ...constraints),
        );
        for (const snapshot of page.docs) yield remoteSchema.parse(snapshot.data());
        if (page.size < 200) return;
        cursor = page.docs.at(-1);
      }
    },
  };
}
