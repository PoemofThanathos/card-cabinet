import { auth } from './firebase';
import { db, setting, photoBlob, type CabinetDB } from './db';
import { suggestionSchema, type Card } from './model';
import { transmittedPhoto } from './photos';
import {
  aiClientTimeoutMs,
  defaultIdentificationOptions,
  normalizeIdentificationOptions,
  type IdentificationOptions,
} from './ai-options';

export async function readIdentificationOptions(database: CabinetDB = db) {
  return normalizeIdentificationOptions(
    await setting<unknown>('aiOptions', defaultIdentificationOptions, database),
  );
}

export async function identify(card: Card, options?: IdentificationOptions) {
  const chosen = options ?? (await readIdentificationOptions());
  if (!(await setting('aiEnabled', false)))
    throw new Error('Enable identification in Settings first.');
  if (!auth?.currentUser)
    throw new Error('Sign in to identify a card. Manual entry works offline.');
  const url = import.meta.env.VITE_WORKER_URL;
  if (!url || !url.startsWith('https://'))
    throw new Error('Configure your HTTPS Worker URL first.');
  const day = new Date().toISOString().slice(0, 10);
  const usage = await setting('aiUsage', { day, count: 0 });
  const count = usage.day === day ? usage.count : 0;
  const limit = Math.min(5, Math.max(1, await setting('aiLimit', 3)));
  if (!(await setting('aiUnlimited', false)) && count >= limit)
    throw new Error('This device reached its daily scan limit. This is not an OpenAI billing cap.');
  const front = card.photos.front ? await db.photos.get(card.photos.front) : null;
  const back = card.photos.back ? await db.photos.get(card.photos.back) : null;
  if (!front || !back)
    throw new Error(
      'Both photos must be available on this device. Save your photos before identifying.',
    );
  const images = await Promise.all([
    transmittedPhoto(photoBlob(front)),
    transmittedPhoto(photoBlob(back)),
  ]);
  const token = await auth.currentUser.getIdToken();
  // Reserve before sending, including failed/ambiguous requests. Do not retry paid calls.
  const unlimited = await db.transaction('rw', db.settings, async () => {
    if (!(await setting('aiEnabled', false)))
      throw new Error('Enable identification in Settings first.');
    const requestDay = new Date().toISOString().slice(0, 10);
    const current = await setting('aiUsage', { day: requestDay, count: 0 });
    const n = current.day === requestDay ? current.count : 0;
    const currentLimit = Math.min(5, Math.max(1, await setting('aiLimit', 3)));
    const uncapped = await setting('aiUnlimited', false);
    if (!uncapped && n >= currentLimit)
      throw new Error('This device reached its daily scan limit.');
    await db.settings.put({ key: 'aiUsage', value: { day: requestDay, count: n + 1 } });
    return uncapped;
  });
  const response = await fetch(url.replace(/\/$/, '') + '/identify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({ requestId: crypto.randomUUID(), images, unlimited, ...chosen }),
    signal: AbortSignal.timeout(aiClientTimeoutMs),
  });
  let result: unknown;
  try {
    result = await response.json();
  } catch {
    throw new Error(
      (response.ok
        ? 'Identification returned an unreadable response.'
        : `Identification failed with HTTP ${response.status}.`) +
        ' The attempt may have been billed. No automatic retry was sent.',
    );
  }
  if (!response.ok) {
    const error = (result as { error?: unknown })?.error;
    throw new Error(
      typeof error === 'string'
        ? error
        : 'Identification failed. The request may have been billed; it will not retry automatically.',
    );
  }
  return suggestionSchema.parse(result);
}
