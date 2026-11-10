import { auth } from './firebase';
import { db, setting, photoBlob } from './db';
import { suggestionSchema, type Card } from './model';
import { transmittedPhoto } from './photos';
export async function identify(card: Card) {
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
  if (count >= limit)
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
  await db.transaction('rw', db.settings, async () => {
    const current = await setting('aiUsage', { day, count: 0 });
    const n = current.day === day ? current.count : 0;
    if (n >= limit) throw new Error('This device reached its daily scan limit.');
    await db.settings.put({ key: 'aiUsage', value: { day, count: n + 1 } });
  });
  const response = await fetch(url.replace(/\/$/, '') + '/identify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({ requestId: crypto.randomUUID(), images }),
    signal: AbortSignal.timeout(60000),
  });
  const result = await response.json();
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
