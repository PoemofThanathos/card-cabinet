import { beforeAll, afterAll, beforeEach, it, expect } from 'vitest';
import {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import {
  doc,
  setDoc,
  getDoc,
  updateDoc,
  deleteDoc,
  collection,
  getDocs,
  Timestamp,
} from 'firebase/firestore';
import { readFileSync } from 'node:fs';
import { newCard } from '../src/model';
let env: RulesTestEnvironment;
beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-card-cabinet',
    firestore: {
      host: '127.0.0.1',
      port: 8080,
      rules: readFileSync('firestore.rules', 'utf8').replaceAll('REPLACE_WITH_OWNER_UID', 'owner'),
    },
  });
});
beforeEach(() => env.clearFirestore());
afterAll(() => env.cleanup());
const record = () => ({ rev: 1, mutationId: crypto.randomUUID(), card: newCard() });
it('permits only the configured UID and isolates paths', async () => {
  const r = record();
  const path = 'users/owner/cards/' + r.card.id;
  await assertSucceeds(setDoc(doc(env.authenticatedContext('owner').firestore(), path), r));
  await assertFails(getDoc(doc(env.unauthenticatedContext().firestore(), path)));
  await assertFails(getDoc(doc(env.authenticatedContext('other').firestore(), path)));
  await assertFails(
    setDoc(doc(env.authenticatedContext('other').firestore(), 'users/other/cards/' + r.card.id), r),
  );
});
it('rejects photo payloads, extra keys, oversized fields and wrong IDs', async () => {
  const r = record();
  const ref = doc(env.authenticatedContext('owner').firestore(), 'users/owner/cards/' + r.card.id);
  await assertFails(setDoc(ref, { ...r, base64: 'abc' }));
  await assertFails(
    setDoc(ref, {
      ...r,
      card: { ...r.card, photos: { front: 'data:image/jpeg;base64,abc', back: null } },
    }),
  );
  await assertFails(
    setDoc(ref, { ...r, card: { ...r.card, fields: { ...r.card.fields, name: 'x'.repeat(301) } } }),
  );
  await assertFails(setDoc(ref, { ...r, card: { ...r.card, id: crypto.randomUUID() } }));
  await assertFails(
    setDoc(ref, { ...r, card: { ...r.card, fields: { ...r.card.fields, hidden: 'no' } } }),
  );
});
it('requires monotonic revisions and retains recoverable tombstones', async () => {
  const r = record();
  const ref = doc(env.authenticatedContext('owner').firestore(), 'users/owner/cards/' + r.card.id);
  await assertSucceeds(setDoc(ref, r));
  await assertFails(updateDoc(ref, { rev: 1 }));
  await assertFails(updateDoc(ref, { rev: 3 }));
  await assertSucceeds(updateDoc(ref, { rev: 2, 'card.status': 'deleted' }));
  await assertFails(deleteDoc(ref));
  await assertSucceeds(updateDoc(ref, { rev: 3, 'card.status': 'active' }));
  expect((await getDoc(ref)).data()?.card.status).toBe('active');
});
it('accepts Japanese fields and hash references only', async () => {
  const r = record();
  r.card.fields.japaneseName = '大谷翔平';
  r.card.photos.front = 'a'.repeat(64);
  await assertSucceeds(
    setDoc(doc(env.authenticatedContext('owner').firestore(), 'users/owner/cards/' + r.card.id), r),
  );
});
it('expires authenticated signaling and permits only one answer', async () => {
  const fs = env.authenticatedContext('owner').firestore();
  const id = 'a'.repeat(32),
    ref = doc(fs, 'users/owner/pairings/' + id);
  await assertSucceeds(
    setDoc(ref, {
      offer: 'v=0',
      answer: null,
      expiresAt: Timestamp.fromMillis(Date.now() + 300000),
    }),
  );
  await assertFails(getDocs(collection(fs, 'users/owner/pairings')));
  await assertSucceeds(updateDoc(ref, { answer: 'v=0 answer' }));
  await assertFails(updateDoc(ref, { answer: 'second' }));
  await assertFails(
    getDoc(doc(env.authenticatedContext('other').firestore(), 'users/owner/pairings/' + id)),
  );
  await assertSucceeds(deleteDoc(ref));
  await assertFails(
    setDoc(ref, {
      offer: 'v=0',
      answer: null,
      expiresAt: Timestamp.fromMillis(Date.now() + 3600000),
    }),
  );
  await env.withSecurityRulesDisabled(async (c) => {
    await setDoc(doc(c.firestore(), 'users/owner/pairings/' + id), {
      offer: 'v=0',
      answer: null,
      expiresAt: Timestamp.fromMillis(Date.now() - 10000),
    });
  });
  await assertFails(getDoc(ref));
  await assertSucceeds(deleteDoc(ref));
});
