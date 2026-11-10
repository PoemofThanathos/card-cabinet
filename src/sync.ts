import { type CabinetDB, db, setting, setSetting } from './db';
import { type Operation, type RemoteCard, plainCard, sameCard } from './model';

export interface CloudStore {
  commit(op: Operation): Promise<{ ok: boolean; remote: RemoteCard }>;
  list(): AsyncIterable<RemoteCard>;
}
export async function syncCollection(cloud: CloudStore, uid: string, database: CabinetDB = db) {
  if ((await setting('ownerUid', '', database)) !== uid)
    throw new Error('Link this device to this Firebase UID before syncing.');
  let conflicts = 0;
  for (const op of await database.queue.toArray()) {
    if (await database.conflicts.get(op.id)) continue;
    const result = await cloud.commit(op); // A failed network call leaves this operation queued.
    await database.transaction(
      'rw',
      database.cards,
      database.queue,
      database.conflicts,
      async () => {
        const local = await database.cards.get(op.id);
        if (!local) return;
        if (!result.ok) {
          await database.conflicts.put({
            id: op.id,
            local: plainCard(local),
            remote: result.remote,
          });
          conflicts++;
          return;
        }
        const current = await database.queue.get(op.id);
        await database.cards.update(op.id, {
          baseRev: result.remote.rev,
          syncedVersion: Math.max(local.syncedVersion, op.version),
        });
        if (current?.mutationId === op.mutationId) await database.queue.delete(op.id);
        else if (current) await database.queue.update(op.id, { baseRev: result.remote.rev });
      },
    );
  }
  for await (const remote of cloud.list()) {
    await database.transaction(
      'rw',
      database.cards,
      database.queue,
      database.conflicts,
      async () => {
        const local = await database.cards.get(remote.card.id);
        if (local && remote.rev <= local.baseRev) return;
        if (local && (await database.queue.get(local.id))) {
          if (sameCard(local, remote.card)) {
            await database.queue.delete(local.id);
            await database.conflicts.delete(local.id);
            await database.cards.update(local.id, {
              baseRev: remote.rev,
              syncedVersion: local.localVersion,
            });
          } else {
            await database.conflicts.put({ id: local.id, local: plainCard(local), remote });
            conflicts++;
          }
        } else {
          await database.cards.put({
            ...remote.card,
            baseRev: remote.rev,
            localVersion: local?.localVersion ?? 1,
            syncedVersion: local?.localVersion ?? 1,
          });
        }
      },
    );
  }
  await setSetting('lastSync', new Date().toISOString(), database);
  return conflicts;
}
export async function resolveConflict(
  id: string,
  choice: 'local' | 'remote' | 'both',
  database = db,
) {
  await database.transaction('rw', database.cards, database.queue, database.conflicts, async () => {
    const conflict = await database.conflicts.get(id);
    const local = await database.cards.get(id);
    if (!conflict || !local) return;
    const remote = conflict.remote;
    if (choice === 'both') {
      const card = { ...plainCard(local), id: crypto.randomUUID() };
      await database.cards.put({ ...card, baseRev: 0, localVersion: 1, syncedVersion: 0 });
      await database.queue.put({
        id: card.id,
        mutationId: crypto.randomUUID(),
        baseRev: 0,
        version: 1,
        card,
      });
    }
    if (choice === 'remote' || choice === 'both') {
      await database.cards.put({
        ...remote.card,
        baseRev: remote.rev,
        localVersion: local.localVersion + 1,
        syncedVersion: local.localVersion + 1,
      });
      await database.queue.delete(id);
    } else {
      const version = local.localVersion + 1;
      const card = plainCard(local);
      await database.cards.update(id, { baseRev: remote.rev, localVersion: version });
      await database.queue.put({
        id,
        mutationId: crypto.randomUUID(),
        baseRev: remote.rev,
        version,
        card,
      });
    }
    await database.conflicts.delete(id);
  });
}
