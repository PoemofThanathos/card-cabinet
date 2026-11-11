import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CabinetDB,
  changeStatus,
  duplicateCard,
  purgeDeletedCards,
  saveCard,
  setSetting,
  setting,
} from '../src/db';
import {
  cardSchema,
  emptyFields,
  newCard,
  plainCard,
  purgedCard,
  type Card,
  type Operation,
  type RemoteCard,
} from '../src/model';
import { resolveConflict, syncCollection, type CloudStore } from '../src/sync';

let database: CabinetDB;
beforeEach(async () => {
  database = new CabinetDB('purge-' + crypto.randomUUID());
  await database.open();
  await setSetting('ownerUid', 'owner', database);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await database.delete();
});

const hash = (n: number) => n.toString(16).padStart(64, '0');
function card(status: Card['status'] = 'deleted', photo = 1): Card {
  const result = newCard();
  result.status = status;
  result.fields.name = 'Private player';
  result.fields.notes = 'Private notes';
  result.photos = { front: hash(photo), back: null };
  return result;
}
const remote = (card: Card, rev = 1): RemoteCard => ({
  card,
  rev,
  mutationId: crypto.randomUUID(),
});
async function store(card: Card) {
  await saveCard(
    card,
    [{ hash: card.photos.front!, bytes: new ArrayBuffer(4), size: 4, type: 'image/jpeg' }],
    database,
  );
}

class Cloud implements CloudStore {
  docs = new Map<string, RemoteCard>();
  afterCommit?: () => Promise<void>;
  beforeList?: () => Promise<void>;
  fail = false;
  calls: Operation[] = [];
  async commit(op: Operation) {
    this.calls.push(structuredClone(op));
    if (this.fail) throw new Error('Network unavailable');
    const old = this.docs.get(op.id);
    if (old?.card.status === 'purged')
      return { ok: op.card.status === 'purged', remote: structuredClone(old) };
    if (old?.mutationId === op.mutationId) return { ok: true, remote: structuredClone(old) };
    if ((old?.rev ?? 0) !== op.baseRev) return { ok: false, remote: structuredClone(old!) };
    const next = { rev: (old?.rev ?? 0) + 1, card: op.card, mutationId: op.mutationId };
    this.docs.set(op.id, structuredClone(next));
    await this.afterCommit?.();
    return { ok: true, remote: structuredClone(next) };
  }
  async *list() {
    await this.beforeList?.();
    for (const value of this.docs.values()) yield structuredClone(value);
  }
}

describe('permanent deletion on this device', () => {
  it('purges only snapshot IDs still deleted, queues a blank tombstone, and cannot run twice', async () => {
    const deleted = card(),
      restored = card('active', 2),
      archived = card('archived', 3),
      laterDeleted = card('deleted', 4);
    for (const value of [deleted, restored, archived, laterDeleted]) await store(value);
    await database.cards.update(deleted.id, { baseRev: 9, syncedVersion: 1 });
    const untouched = await database.cards.bulkGet([restored.id, archived.id, laterDeleted.id]);
    expect(
      await purgeDeletedCards(
        [deleted.id, restored.id, archived.id, deleted.id, crypto.randomUUID()],
        database,
      ),
    ).toBe(1);
    const purged = (await database.cards.get(deleted.id))!;
    expect(purged).toMatchObject({
      status: 'purged',
      fields: emptyFields(),
      photos: { front: null, back: null },
      baseRev: 9,
      localVersion: 2,
      syncedVersion: 1,
    });
    expect(await database.queue.get(deleted.id)).toMatchObject({
      baseRev: 9,
      version: 2,
      card: plainCard(purged),
    });
    expect(await database.photos.get(hash(1))).toBeUndefined();
    expect(await database.cards.bulkGet([restored.id, archived.id, laterDeleted.id])).toEqual(
      untouched,
    );
    const queue = await database.queue.get(deleted.id);
    expect(await purgeDeletedCards([deleted.id], database)).toBe(0);
    expect(await database.queue.get(deleted.id)).toEqual(queue);
    await expect(saveCard(deleted, [], database)).rejects.toThrow('permanently deleted');
    await expect(changeStatus(deleted, 'active', database)).rejects.toThrow('permanently deleted');
    await expect(duplicateCard(deleted, database)).rejects.toThrow('permanently deleted');
    await expect(setSetting('draft', { card: deleted, base: deleted }, database)).rejects.toThrow(
      'permanently deleted',
    );
  });

  it('clears matching snapshots and conflicts while preserving photos referenced by other cards or drafts', async () => {
    const deleted = card(),
      shared = card('active'),
      unrelated = card('active', 2);
    await store(deleted);
    await store(shared);
    await store(unrelated);
    const draft = card('active', 3);
    await database.photos.put({
      hash: hash(3),
      bytes: new ArrayBuffer(2),
      type: 'image/jpeg',
      size: 2,
    });
    await setSetting('draft', { card: draft, base: null }, database);
    const old = structuredClone(deleted);
    old.photos.back = hash(3);
    await setSetting(
      'aiBatchReview:job:' + deleted.id,
      { card: old, result: { private: 'details' } },
      database,
    );
    await setSetting('aiBatchReview:job:' + shared.id, { card: shared }, database);
    await setSetting(
      'bulkEntry:plan:0000',
      { card: deleted, state: 'saved', sources: [{ name: 'private.jpg' }] },
      database,
    );
    await setSetting(
      'aiBatch',
      {
        cardIds: [deleted.id, shared.id],
        position: 0,
        processing: deleted.id,
        failures: [
          { cardId: deleted.id, name: 'Private name', error: 'Private error' },
          { cardId: shared.id, name: 'Keep' },
        ],
        error: 'Private error',
      },
      database,
    );
    await database.conflicts.put({ id: deleted.id, local: deleted, remote: remote(old) });
    expect(await purgeDeletedCards([deleted.id], database)).toBe(1);
    expect(await database.conflicts.get(deleted.id)).toBeUndefined();
    expect(await setting('aiBatchReview:job:' + deleted.id, null, database)).toBeNull();
    expect(await setting('aiBatchReview:job:' + shared.id, null, database)).not.toBeNull();
    expect(await setting('draft', null, database)).toEqual({ card: draft, base: null });
    expect(await setting('bulkEntry:plan:0000', null, database)).toMatchObject({
      state: 'skipped',
      card: { status: 'purged', fields: emptyFields(), photos: { front: null, back: null } },
    });
    expect(await setting('aiBatch', null, database)).toMatchObject({
      processing: deleted.id,
      failures: [{ cardId: shared.id, name: 'Keep' }],
      error: '',
    });
    expect(await database.photos.get(hash(1))).toBeDefined();
    expect(await database.photos.get(hash(3))).toBeDefined();
  });

  it('removes the matching editor draft and photos while leaving unrelated cached photos alone', async () => {
    const deleted = card();
    await store(deleted);
    await setSetting('draft', { card: deleted, base: deleted }, database);
    await database.photos.put({
      hash: hash(99),
      bytes: new ArrayBuffer(2),
      type: 'image/jpeg',
      size: 2,
    });
    await purgeDeletedCards([deleted.id], database);
    expect(await setting('draft', null, database)).toBeNull();
    expect(await database.photos.get(hash(1))).toBeUndefined();
    expect(await database.photos.get(hash(99))).toBeDefined();
  });

  it('rolls back cards, queue, drafts and photos if photo cleanup fails', async () => {
    const deleted = card();
    await store(deleted);
    await setSetting('draft', { card: deleted, base: deleted }, database);
    const before = await database.cards.get(deleted.id);
    const queue = await database.queue.get(deleted.id);
    vi.spyOn(database.photos, 'bulkDelete').mockImplementation(() => {
      throw new Error('Storage failed');
    });
    await expect(purgeDeletedCards([deleted.id], database)).rejects.toThrow('Storage failed');
    expect(await database.cards.get(deleted.id)).toEqual(before);
    expect(await database.queue.get(deleted.id)).toEqual(queue);
    expect(await setting('draft', null, database)).toEqual({ card: deleted, base: deleted });
    expect(await database.photos.get(hash(1))).toBeDefined();
  });

  it('rejects a tombstone carrying any fields or photo references', () => {
    const purged = purgedCard(card());
    expect(cardSchema.safeParse(purged).success).toBe(true);
    expect(
      cardSchema.safeParse({ ...purged, fields: { ...purged.fields, notes: 'retained' } }).success,
    ).toBe(false);
    expect(
      cardSchema.safeParse({ ...purged, photos: { front: hash(1), back: null } }).success,
    ).toBe(false);
  });
});

describe('permanent deletion across devices', () => {
  it('keeps an offline purge queued across reopen and rebases over a newer cloud revision without a conflict', async () => {
    const deleted = card();
    await store(deleted);
    const cloud = new Cloud();
    await syncCollection(cloud, 'owner', database);
    await purgeDeletedCards([deleted.id], database);
    cloud.fail = true;
    await expect(syncCollection(cloud, 'owner', database)).rejects.toThrow('Network');
    database.close();
    await database.open();
    cloud.fail = false;
    cloud.docs.set(deleted.id, remote({ ...deleted, status: 'active' }, 2));
    expect(await syncCollection(cloud, 'owner', database)).toBe(0);
    expect(cloud.docs.get(deleted.id)?.card.status).toBe('purged');
    expect(cloud.docs.get(deleted.id)?.rev).toBe(3);
    expect(await database.queue.count()).toBe(0);
    expect(await database.conflicts.count()).toBe(0);
  });

  it('applies a remote purge over stale local edits and removes recoverable snapshots', async () => {
    const deleted = card();
    await store(deleted);
    const cloud = new Cloud();
    await syncCollection(cloud, 'owner', database);
    await saveCard(
      { ...deleted, status: 'active', fields: { ...deleted.fields, name: 'Offline edit' } },
      [],
      database,
    );
    await setSetting('draft', { card: deleted, base: deleted }, database);
    cloud.docs.set(deleted.id, remote(purgedCard(deleted), 2));
    expect(await syncCollection(cloud, 'owner', database)).toBe(0);
    expect((await database.cards.get(deleted.id))?.status).toBe('purged');
    expect(await database.queue.count()).toBe(0);
    expect(await database.conflicts.count()).toBe(0);
    expect(await setting('draft', null, database)).toBeNull();
    expect(await database.photos.get(hash(1))).toBeUndefined();
  });

  it('preserves a newer local purge while an older normal commit is in flight', async () => {
    const deleted = card();
    await store(deleted);
    const cloud = new Cloud();
    cloud.afterCommit = async () => {
      cloud.afterCommit = undefined;
      await purgeDeletedCards([deleted.id], database);
    };
    expect(await syncCollection(cloud, 'owner', database)).toBe(0);
    expect((await database.cards.get(deleted.id))?.status).toBe('purged');
    expect(cloud.docs.get(deleted.id)?.card.status).toBe('purged');
    expect(await database.queue.count()).toBe(0);
    expect(await database.conflicts.count()).toBe(0);
  });

  it('retains a local purge during an in-flight cloud list and queues it over the pulled revision', async () => {
    const deleted = card();
    await store(deleted);
    const cloud = new Cloud();
    await syncCollection(cloud, 'owner', database);
    cloud.docs.set(deleted.id, remote({ ...deleted, status: 'active' }, 2));
    cloud.beforeList = async () => {
      cloud.beforeList = undefined;
      await purgeDeletedCards([deleted.id], database);
    };
    expect(await syncCollection(cloud, 'owner', database)).toBe(0);
    expect((await database.cards.get(deleted.id))?.status).toBe('purged');
    expect(await database.queue.get(deleted.id)).toMatchObject({
      baseRev: 2,
      card: { status: 'purged' },
    });
    expect(await database.conflicts.count()).toBe(0);
    await syncCollection(cloud, 'owner', database);
    expect(cloud.docs.get(deleted.id)?.card.status).toBe('purged');
  });

  it('does not delete a photo before a later cloud record introduces a surviving shared copy', async () => {
    const deleted = card();
    await store(deleted);
    const shared = card('active');
    const cloud = new Cloud();
    cloud.docs.set(deleted.id, remote(purgedCard(deleted), 2));
    cloud.docs.set(shared.id, remote(shared));
    await syncCollection(cloud, 'owner', database);
    expect((await database.cards.get(shared.id))?.photos.front).toBe(hash(1));
    expect(await database.photos.get(hash(1))).toBeDefined();
    expect(await setting('purgePhotoCandidates', null, database)).toBeNull();
  });

  it('does not resurrect a purged card when another offline device reconnects with an edit', async () => {
    const second = new CabinetDB('purge-second-' + crypto.randomUUID());
    try {
      await second.open();
      await setSetting('ownerUid', 'owner', second);
      const original = card('active');
      await store(original);
      const cloud = new Cloud();
      await syncCollection(cloud, 'owner', database);
      await syncCollection(cloud, 'owner', second);
      await saveCard(
        { ...original, fields: { ...original.fields, name: 'Offline device edit' } },
        [],
        second,
      );
      await changeStatus(original, 'deleted', database);
      await purgeDeletedCards([original.id], database);
      await syncCollection(cloud, 'owner', database);
      expect(await syncCollection(cloud, 'owner', second)).toBe(0);
      expect((await second.cards.get(original.id))?.fields).toEqual(emptyFields());
      expect((await second.cards.get(original.id))?.status).toBe('purged');
      expect(await second.queue.count()).toBe(0);
      expect(await second.conflicts.count()).toBe(0);
      await expect(saveCard(original, [], second)).rejects.toThrow('permanently deleted');
      await syncCollection(cloud, 'owner', database);
      expect(cloud.docs.get(original.id)?.card.status).toBe('purged');
    } finally {
      await second.delete();
    }
  });

  it('retains deferred photos after a failed pull and cleans them after a complete retry', async () => {
    const deleted = card();
    await store(deleted);
    await database.queue.clear();
    const tombstone = remote(purgedCard(deleted), 2);
    const cloud: CloudStore = {
      commit: async () => {
        throw new Error('Unexpected commit');
      },
      async *list() {
        yield tombstone;
        throw new Error('Pull interrupted');
      },
    };
    await expect(syncCollection(cloud, 'owner', database)).rejects.toThrow('Pull interrupted');
    expect((await database.cards.get(deleted.id))?.status).toBe('purged');
    expect(await database.photos.get(hash(1))).toBeDefined();
    database.close();
    await database.open();
    cloud.list = async function* () {
      yield tombstone;
    };
    await syncCollection(cloud, 'owner', database);
    expect(await database.photos.get(hash(1))).toBeUndefined();
    expect(await setting('purgePhotoCandidates', null, database)).toBeNull();
  });

  it.each(['local', 'remote', 'both'] as const)(
    'cannot use conflict choice %s to resurrect a remote purge',
    async (choice) => {
      const deleted = card();
      await store(deleted);
      await database.conflicts.put({
        id: deleted.id,
        local: deleted,
        remote: remote(purgedCard(deleted), 2),
      });
      await resolveConflict(deleted.id, choice, database);
      expect(await database.cards.count()).toBe(1);
      expect((await database.cards.get(deleted.id))?.status).toBe('purged');
      expect(await database.queue.count()).toBe(0);
      expect(await database.conflicts.count()).toBe(0);
    },
  );
});
