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
import { newCard, purgedCard } from '../src/model';
const rules = readFileSync('firestore.rules', 'utf8');
const ownerUid = rules.match(/&& uid == '([^']+)'/)?.[1];
if (!ownerUid) throw new Error('The rules must declare one configured owner UID.');
let env: RulesTestEnvironment;
beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-card-cabinet',
    firestore: {
      host: '127.0.0.1',
      port: 8080,
      rules,
    },
  });
});
beforeEach(() => env.clearFirestore());
afterAll(() => env.cleanup());
const record = () => ({ rev: 1, mutationId: crypto.randomUUID(), card: newCard() });
it('permits only the configured UID and isolates paths', async () => {
  const r = record();
  const path = `users/${ownerUid}/cards/` + r.card.id;
  await assertSucceeds(setDoc(doc(env.authenticatedContext(ownerUid).firestore(), path), r));
  await assertFails(getDoc(doc(env.unauthenticatedContext().firestore(), path)));
  await assertFails(getDoc(doc(env.authenticatedContext('other').firestore(), path)));
  await assertFails(
    setDoc(doc(env.authenticatedContext('other').firestore(), 'users/other/cards/' + r.card.id), r),
  );
});
it('rejects photo payloads, extra keys, oversized fields and wrong IDs', async () => {
  const r = record();
  const ref = doc(
    env.authenticatedContext(ownerUid).firestore(),
    `users/${ownerUid}/cards/` + r.card.id,
  );
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
  const ref = doc(
    env.authenticatedContext(ownerUid).firestore(),
    `users/${ownerUid}/cards/` + r.card.id,
  );
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
    setDoc(
      doc(env.authenticatedContext(ownerUid).firestore(), `users/${ownerUid}/cards/` + r.card.id),
      r,
    ),
  );
});
it('keeps permanent deletion terminal and allows only blank tombstones', async () => {
  const r = record();
  r.card.fields.name = 'Private card name';
  r.card.photos.front = 'a'.repeat(64);
  const ref = doc(
    env.authenticatedContext(ownerUid).firestore(),
    `users/${ownerUid}/cards/` + r.card.id,
  );
  await assertSucceeds(setDoc(ref, r));
  await assertFails(updateDoc(ref, { rev: 2, 'card.status': 'purged' }));
  const tombstone = purgedCard(r.card);
  await assertFails(
    updateDoc(ref, {
      rev: 2,
      card: { ...tombstone, fields: { ...tombstone.fields, notes: 'retained' } },
    }),
  );
  await assertFails(
    updateDoc(ref, {
      rev: 2,
      card: { ...tombstone, photos: { front: 'a'.repeat(64), back: null } },
    }),
  );
  await assertSucceeds(updateDoc(ref, { rev: 2, card: tombstone }));
  for (const status of ['active', 'archived', 'deleted'])
    await assertFails(updateDoc(ref, { rev: 3, card: { ...r.card, status } }));
  await assertFails(deleteDoc(ref));
  await assertSucceeds(updateDoc(ref, { rev: 3, card: tombstone }));
  expect((await getDoc(ref)).data()?.card).toEqual(tombstone);
});
it('allows an offline card to first sync as a blank permanent deletion', async () => {
  const r = record();
  const tombstone = { ...r, card: purgedCard(r.card) };
  const ref = doc(
    env.authenticatedContext(ownerUid).firestore(),
    `users/${ownerUid}/cards/` + r.card.id,
  );
  await assertSucceeds(setDoc(ref, tombstone));
  await assertFails(updateDoc(ref, { rev: 2, card: r.card }));
});
it('expires authenticated signaling and permits only one answer', async () => {
  const fs = env.authenticatedContext(ownerUid).firestore();
  const id = 'a'.repeat(32),
    ref = doc(fs, `users/${ownerUid}/pairings/` + id);
  await assertSucceeds(
    setDoc(ref, {
      offer: 'v=0',
      answer: null,
      expiresAt: Timestamp.fromMillis(Date.now() + 300000),
    }),
  );
  await assertFails(getDocs(collection(fs, `users/${ownerUid}/pairings`)));
  await assertSucceeds(updateDoc(ref, { answer: 'v=0 answer' }));
  await assertFails(updateDoc(ref, { answer: 'second' }));
  await assertFails(
    getDoc(doc(env.authenticatedContext('other').firestore(), `users/${ownerUid}/pairings/` + id)),
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
    await setDoc(doc(c.firestore(), `users/${ownerUid}/pairings/` + id), {
      offer: 'v=0',
      answer: null,
      expiresAt: Timestamp.fromMillis(Date.now() - 10000),
    });
  });
  await assertFails(getDoc(ref));
  await assertSucceeds(deleteDoc(ref));
});
