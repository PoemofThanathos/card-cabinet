import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Dexie from 'dexie';
import {
  CabinetDB,
  saveCard,
  duplicateCard,
  changeStatus,
  makePhoto,
  setSetting,
  friendlyError,
} from '../src/db';
import { newCard, matchCard, type RemoteCard, type Operation, plainCard } from '../src/model';
import { exportPackage, readPackage, planImport, applyImport, csvExport } from '../src/backup';
import { syncCollection, resolveConflict, type CloudStore } from '../src/sync';
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
let db: CabinetDB;
beforeEach(async () => {
  db = new CabinetDB('test-' + crypto.randomUUID());
  await db.open();
});
afterEach(async () => {
  await db.delete();
  vi.restoreAllMocks();
});
function card() {
  const c = newCard();
  c.fields.name = 'Shohei Ohtani';
  c.fields.japaneseName = '大谷翔平';
  c.fields.notes = '直筆？ 🃏';
  c.fields.cardNumber = '０１７';
  return c;
}
class MockCloud implements CloudStore {
  docs = new Map<string, RemoteCard>();
  fail = false;
  afterCommit?: () => Promise<void>;
  async commit(op: Operation) {
    if (this.fail) throw new Error('Network unavailable');
    const old = this.docs.get(op.id);
    if (old?.mutationId === op.mutationId) return { ok: true, remote: old };
    if ((old?.rev ?? 0) !== op.baseRev) return { ok: false, remote: old! };
    const remote = { rev: (old?.rev ?? 0) + 1, mutationId: op.mutationId, card: op.card };
    this.docs.set(op.id, structuredClone(remote));
    await this.afterCommit?.();
    return { ok: true, remote };
  }
  async *list() {
    for (const d of this.docs.values()) yield structuredClone(d);
  }
}
describe('local collection', () => {
  it('migrates stored Blob photos to portable image bytes', async () => {
    const name = 'photo-migration-' + crypto.randomUUID();
    const old = new Dexie(name);
    old
      .version(2)
      .stores({
        cards: 'id,status,updatedAt',
        photos: 'hash',
        queue: 'id',
        settings: 'key',
        conflicts: 'id',
      });
    await old
      .table('photos')
      .put({
        hash: 'a'.repeat(64),
        blob: new Blob([new Uint8Array([255, 216, 255, 217])], { type: 'image/jpeg' }),
        type: 'image/jpeg',
        size: 4,
      });
    old.close();
    const migrated = new CabinetDB(name);
    const photo = await migrated.photos.get('a'.repeat(64));
    expect([...new Uint8Array(photo!.bytes)]).toEqual([255, 216, 255, 217]);
    expect(photo).not.toHaveProperty('blob');
    await migrated.delete();
  });
  it('refuses to overwrite a card edited since the editor opened', async () => {
    const c = card();
    await saveCard(c, [], db);
    await saveCard({ ...c, fields: { ...c.fields, name: 'Other tab' } }, [], db);
    await expect(
      saveCard({ ...c, fields: { ...c.fields, name: 'Stale editor' } }, [], db, c),
    ).rejects.toThrow('changed in another tab');
    expect((await db.cards.get(c.id))?.fields.name).toBe('Other tab');
  });
  it('preserves Unicode and searches full-width card numbers', async () => {
    const c = card();
    await saveCard(c, [], db);
    const stored = (await db.cards.get(c.id))!;
    expect(stored.fields.japaneseName).toBe('大谷翔平');
    expect(stored.fields.notes).toBe('直筆？ 🃏');
    expect(matchCard(stored, '017')).toBe(true);
    expect(matchCard(stored, '大谷')).toBe(true);
    expect(await db.queue.count()).toBe(1);
  });
  it('keeps identical physical copies under different IDs', async () => {
    const c = card();
    await saveCard(c, [], db);
    const copy = await duplicateCard(c, db);
    expect(copy.id).not.toBe(c.id);
    expect(await db.cards.count()).toBe(2);
    expect(copy.fields).toEqual(c.fields);
  });
  it('archives, soft-deletes, and restores without losing metadata', async () => {
    const c = card();
    await saveCard(c, [], db);
    await changeStatus(c, 'archived', db);
    expect((await db.cards.get(c.id))?.status).toBe('archived');
    await changeStatus(c, 'deleted', db);
    expect((await db.cards.get(c.id))?.status).toBe('deleted');
    await changeStatus(c, 'active', db);
    expect((await db.cards.get(c.id))?.fields.japaneseName).toBe('大谷翔平');
    expect(await db.queue.count()).toBe(1);
  });
  it('rolls back a failed save and gives a storage quota message', async () => {
    const c = card();
    await saveCard(c, [], db);
    vi.spyOn(db.queue, 'put').mockRejectedValueOnce(new DOMException('full', 'QuotaExceededError'));
    c.fields.name = 'Changed';
    await expect(saveCard(c, [], db)).rejects.toThrow();
    expect((await db.cards.get(c.id))?.fields.name).toBe('Shohei Ohtani');
    expect(friendlyError(new DOMException('full', 'QuotaExceededError'))).toContain(
      'storage is full',
    );
  });
  it('migrates a version 1 database without erasing cards', async () => {
    const name = 'migration-' + crypto.randomUUID();
    const old = new Dexie(name);
    old
      .version(1)
      .stores({ cards: 'id,status,updatedAt', photos: 'hash', queue: 'id', settings: 'key' });
    const c = card();
    await old.table('cards').put(c);
    old.close();
    const migrated = new CabinetDB(name);
    expect((await migrated.cards.get(c.id))?.localVersion).toBe(1);
    expect((await migrated.cards.get(c.id))?.fields.japaneseName).toBe('大谷翔平');
    await migrated.delete();
  });
});
describe('backup packages', () => {
  it('restores empty installations and makes repeated imports idempotent', async () => {
    const c = card();
    const photo = await makePhoto(
      new Blob([new Uint8Array([255, 216, 1, 2, 255, 217])], { type: 'image/jpeg' }),
    );
    c.photos.front = photo.hash;
    await saveCard(c, [photo], db);
    const zip = await exportPackage([c], db);
    const pack = await readPackage(zip);
    const target = new CabinetDB('restore-' + crypto.randomUUID());
    try {
      await applyImport(pack, await planImport(pack, target), target);
      await applyImport(pack, await planImport(pack, target), target);
      expect(await target.cards.count()).toBe(1);
      expect(await target.photos.count()).toBe(1);
      expect((await target.cards.get(c.id))?.fields.japaneseName).toBe('大谷翔平');
    } finally {
      await target.delete();
    }
  });
  it('exports missing-photo references without claiming photos are present', async () => {
    const c = card();
    c.photos.back = 'a'.repeat(64);
    await saveCard(c, [], db);
    const pack = await readPackage(await exportPackage([c], db));
    expect(pack.photos).toHaveLength(0);
    expect(pack.missing).toEqual(['a'.repeat(64)]);
  });
  it('rejects a corrupted photo and unsupported versions before import', async () => {
    const c = card();
    const photo = await makePhoto(
      new Blob([new Uint8Array([255, 216, 1, 2, 255, 217])], { type: 'image/jpeg' }),
    );
    c.photos.front = photo.hash;
    await saveCard(c, [photo], db);
    const files = unzipSync(new Uint8Array(await (await exportPackage([c], db)).arrayBuffer()));
    files['photos/' + photo.hash + '.jpg'][2] = 9;
    await expect(
      readPackage(new Blob([zipSync(files) as Uint8Array<ArrayBuffer>])),
    ).rejects.toThrow('hash mismatch');
    const manifest = JSON.parse(strFromU8(files['manifest.json']));
    manifest.version = 99;
    files['manifest.json'] = strToU8(JSON.stringify(manifest));
    await expect(
      readPackage(new Blob([zipSync(files) as Uint8Array<ArrayBuffer>])),
    ).rejects.toThrow('Unsupported');
  });
  it('rejects unexpected ZIP paths', async () => {
    const zip = zipSync({ '../escape': strToU8('bad') });
    await expect(readPackage(new Blob([zip as Uint8Array<ArrayBuffer>]))).rejects.toThrow(
      'Invalid',
    );
  });
  it('requires a reviewed choice for changed cards and detects stale reviews', async () => {
    const c = card();
    await saveCard(c, [], db);
    const other = { ...structuredClone(c), fields: { ...c.fields, name: 'Backup name' } };
    const pack = { cards: [other], photos: [], missing: [] };
    const rows = await planImport(pack, db);
    expect(rows[0].kind).toBe('different');
    await applyImport(pack, rows, db);
    expect((await db.cards.get(c.id))?.fields.name).toBe(c.fields.name);
    rows[0].choice = 'copy';
    await applyImport(pack, rows, db);
    expect(await db.cards.count()).toBe(2);
    const stale = await planImport(pack, db);
    await saveCard({ ...c, fields: { ...c.fields, name: 'New local edit' } }, [], db);
    await expect(applyImport(pack, stale, db)).rejects.toThrow('changed after');
  });
  it('exports formula-safe CSV with Unicode and quoted newlines', () => {
    const c = card();
    c.fields.name = '=HYPERLINK("bad")';
    c.fields.notes = 'a,b\n日本語';
    const csv = csvExport([c]);
    expect(csv).toContain("'=HYPERLINK");
    expect(csv).toContain('日本語');
    expect(csv).toContain('"a,b\n日本語"');
  });
});
describe('metadata synchronization', () => {
  it('persists offline edits across reopen and retries after network errors', async () => {
    const c = card();
    await saveCard(c, [], db);
    await setSetting('ownerUid', 'owner', db);
    const cloud = new MockCloud();
    cloud.fail = true;
    await expect(syncCollection(cloud, 'owner', db)).rejects.toThrow('Network');
    db.close();
    await db.open();
    expect(await db.queue.count()).toBe(1);
    cloud.fail = false;
    await syncCollection(cloud, 'owner', db);
    expect(await db.queue.count()).toBe(0);
    expect((await db.cards.get(c.id))?.baseRev).toBe(1);
  });
  it('retains queued data after expired-token or permissions errors', async () => {
    const c = card();
    await saveCard(c, [], db);
    await setSetting('ownerUid', 'owner', db);
    const cloud = new MockCloud();
    cloud.commit = async () => {
      throw { code: 'permission-denied' };
    };
    await expect(syncCollection(cloud, 'owner', db)).rejects.toMatchObject({
      code: 'permission-denied',
    });
    expect(await db.queue.count()).toBe(1);
    expect(await db.cards.count()).toBe(1);
    expect(friendlyError({ code: 'auth/user-token-expired' })).toContain('Local cards');
  });
  it('detects concurrent edits and deletion conflicts without device clock ordering', async () => {
    const c = card();
    const cloud = new MockCloud();
    await setSetting('ownerUid', 'owner', db);
    await saveCard(c, [], db);
    await syncCollection(cloud, 'owner', db);
    const old = cloud.docs.get(c.id)!;
    cloud.docs.set(c.id, {
      ...old,
      rev: 2,
      mutationId: crypto.randomUUID(),
      card: { ...old.card, status: 'deleted', updatedAt: '2000-01-01T00:00:00.000Z' },
    });
    await saveCard({ ...c, fields: { ...c.fields, notes: 'Offline edit' } }, [], db);
    await syncCollection(cloud, 'owner', db);
    expect(await db.conflicts.count()).toBe(1);
    expect((await db.cards.get(c.id))?.status).toBe('active');
    await resolveConflict(c.id, 'both', db);
    expect(await db.cards.count()).toBe(2);
    expect((await db.cards.get(c.id))?.status).toBe('deleted');
    expect(await db.queue.count()).toBe(1);
  });
  it('does not erase edits made while a sync request is in flight', async () => {
    const c = card();
    const cloud = new MockCloud();
    await setSetting('ownerUid', 'owner', db);
    await saveCard(c, [], db);
    cloud.afterCommit = async () => {
      await saveCard({ ...c, fields: { ...c.fields, notes: 'Edited during request' } }, [], db);
      cloud.afterCommit = undefined;
    };
    await syncCollection(cloud, 'owner', db);
    expect((await db.cards.get(c.id))?.fields.notes).toBe('Edited during request');
    expect((await db.queue.get(c.id))?.baseRev).toBe(1);
    await syncCollection(cloud, 'owner', db);
    expect(cloud.docs.get(c.id)?.card.fields.notes).toBe('Edited during request');
    expect(await db.queue.count()).toBe(0);
  });
  it('retries an acknowledged write with a lost response without duplication', async () => {
    const c = card();
    const cloud = new MockCloud();
    await setSetting('ownerUid', 'owner', db);
    await saveCard(c, [], db);
    cloud.afterCommit = async () => {
      cloud.afterCommit = undefined;
      throw new Error('Response lost');
    };
    await expect(syncCollection(cloud, 'owner', db)).rejects.toThrow();
    await syncCollection(cloud, 'owner', db);
    expect(cloud.docs.get(c.id)?.rev).toBe(1);
    expect(await db.queue.count()).toBe(0);
  });
  it('pulls metadata with absent photos and rejects another account', async () => {
    const c = card();
    c.photos.front = 'b'.repeat(64);
    const cloud = new MockCloud();
    cloud.docs.set(c.id, { card: c, rev: 1, mutationId: crypto.randomUUID() });
    await setSetting('ownerUid', 'owner', db);
    await expect(syncCollection(cloud, 'stranger', db)).rejects.toThrow('Link');
    await syncCollection(cloud, 'owner', db);
    expect((await db.cards.get(c.id))?.photos.front).toBe('b'.repeat(64));
    expect(await db.photos.count()).toBe(0);
    expect(plainCard((await db.cards.get(c.id))!)).not.toHaveProperty('baseRev');
  });
});
