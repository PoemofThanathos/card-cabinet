import {
  type CabinetDB,
  db,
  setting,
  setSetting,
  acceptRemotePurge,
  collectPurgedPhotos,
} from './db';
import { type LocalCard, type Operation, type RemoteCard, plainCard, sameCard } from './model';

export interface CloudStore {
  commit(op: Operation): Promise<{ ok: boolean; remote: RemoteCard }>;
  list(): AsyncIterable<RemoteCard>;
}

async function rebasePurge(local: LocalCard, remote: RemoteCard, database: CabinetDB) {
  const current = await database.queue.get(local.id);
  const baseRev = Math.max(local.baseRev, remote.rev);
  const version = current ? local.localVersion : local.localVersion + 1;
  await database.cards.update(local.id, { baseRev, localVersion: version });
  await database.queue.put({
    id: local.id,
    mutationId: current?.mutationId ?? crypto.randomUUID(),
    baseRev,
    version,
    card: plainCard(local),
  });
  await database.conflicts.delete(local.id);
}

export async function syncCollection(cloud: CloudStore, uid: string, database: CabinetDB = db) {
  if ((await setting('ownerUid', '', database)) !== uid)
    throw new Error('Link this device to this Firebase UID before syncing.');
  for (const queued of await database.queue.toArray()) {
    // One retry rebases a purge over a concurrent cloud edit. Further churn stays queued.
    for (let attempt = 0; attempt < 2; attempt++) {
      const op = await database.queue.get(queued.id);
      if (!op || (op.card.status !== 'purged' && (await database.conflicts.get(op.id)))) break;
      const result = await cloud.commit(op); // A failed network call leaves this operation queued.
      let retryPurge = false;
      await database.transaction(
        'rw',
        [database.cards, database.photos, database.queue, database.conflicts, database.settings],
        async () => {
          if (result.remote.card.status === 'purged') {
            await acceptRemotePurge(result.remote, database, true);
            return;
          }
          const local = await database.cards.get(op.id);
          if (!local) return;
          if (local.status === 'purged') {
            await rebasePurge(local, result.remote, database);
            retryPurge = true;
            return;
          }
          if (!result.ok) {
            await database.conflicts.put({
              id: op.id,
              local: plainCard(local),
              remote: result.remote,
            });
            return;
          }
          const current = await database.queue.get(op.id);
          await database.cards.update(op.id, {
            baseRev: Math.max(local.baseRev, result.remote.rev),
            syncedVersion: Math.max(local.syncedVersion, op.version),
          });
          if (current?.mutationId === op.mutationId) await database.queue.delete(op.id);
          else if (current) await database.queue.update(op.id, { baseRev: result.remote.rev });
        },
      );
      if (!retryPurge) break;
    }
  }
  for await (const remote of cloud.list()) {
    await database.transaction(
      'rw',
      [database.cards, database.photos, database.queue, database.conflicts, database.settings],
      async () => {
        if (remote.card.status === 'purged') {
          await acceptRemotePurge(remote, database, true);
          return;
        }
        const local = await database.cards.get(remote.card.id);
        if (local?.status === 'purged') {
          if (remote.rev > local.baseRev || (await database.queue.get(local.id)))
            await rebasePurge(local, remote, database);
          return;
        }
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
  await collectPurgedPhotos(database);
  await setSetting('lastSync', new Date().toISOString(), database);
  return database.conflicts.count();
}
export async function resolveConflict(
  id: string,
  choice: 'local' | 'remote' | 'both',
  database = db,
) {
  await database.transaction(
    'rw',
    [database.cards, database.photos, database.queue, database.conflicts, database.settings],
    async () => {
      const conflict = await database.conflicts.get(id);
      const local = await database.cards.get(id);
      if (!conflict || !local) return;
      const remote = conflict.remote;
      if (remote.card.status === 'purged') {
        await acceptRemotePurge(remote, database, true);
        return;
      }
      if (local.status === 'purged') {
        await rebasePurge(local, remote, database);
        return;
      }
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
    },
  );
}
