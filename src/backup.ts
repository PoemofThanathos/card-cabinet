import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import { z } from 'zod';
import { db, type CabinetDB, type Photo, photoHash, photoBlob } from './db';
import {
  cardSchema,
  type Card,
  fields,
  fieldLabels,
  plainCard,
  sameCard,
  copyCard,
  hashSchema,
} from './model';

export const PACKAGE_LIMIT = 200 * 1024 * 1024;
const manifestSchema = z
  .object({
    format: z.literal('card-cabinet'),
    version: z.literal(1),
    exportedAt: z.iso.datetime(),
    cards: z.array(cardSchema),
    photos: z.array(
      z
        .object({
          hash: hashSchema,
          size: z
            .number()
            .int()
            .min(1)
            .max(12 * 1024 * 1024),
          type: z.literal('image/jpeg'),
        })
        .strict(),
    ),
  })
  .strict();
export type ImportPackage = { cards: Card[]; photos: Photo[]; missing: string[] };
export type ImportRow = {
  card: Card;
  existing?: Card;
  choice: 'keep' | 'replace' | 'copy';
  kind: 'new' | 'same' | 'different';
};
export async function exportPackage(cards: Card[], database: CabinetDB = db) {
  const files: Record<string, Uint8Array> = {};
  let size = 0;
  const photos: { hash: string; size: number; type: 'image/jpeg' }[] = [];
  for (const hash of new Set(
    cards.flatMap((c) => Object.values(c.photos)).filter(Boolean) as string[],
  )) {
    const photo = await database.photos.get(hash);
    if (!photo) continue;
    if ((await photoHash(photoBlob(photo))) !== hash)
      throw new Error(
        'A stored photo failed its integrity check. Keep earlier backups and retake this photo.',
      );
    size += photo.size;
    if (size > PACKAGE_LIMIT)
      throw new Error(
        'This package exceeds 200 MB. Filter the collection and export it in smaller groups.',
      );
    files['photos/' + hash + '.jpg'] = new Uint8Array(photo.bytes);
    photos.push({ hash, size: photo.size, type: 'image/jpeg' });
  }
  files['manifest.json'] = strToU8(
    JSON.stringify({
      format: 'card-cabinet',
      version: 1,
      exportedAt: new Date().toISOString(),
      cards: cards.map(plainCard),
      photos,
    }),
  );
  if (size + files['manifest.json'].length > PACKAGE_LIMIT)
    throw new Error('This package exceeds 200 MB. Export a smaller selection.');
  return new Blob([zipSync(files, { level: 0 }) as Uint8Array<ArrayBuffer>], {
    type: 'application/zip',
  });
}
export async function readPackage(blob: Blob): Promise<ImportPackage> {
  if (blob.size > PACKAGE_LIMIT + 1024 * 1024)
    throw new Error('Package too large. Use packages of 200 MB or less.');
  let size = 0;
  const names = new Set<string>();
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(new Uint8Array(await blob.arrayBuffer()), {
      filter: (entry) => {
        if (names.has(entry.name)) throw new Error('Duplicate ZIP entry');
        names.add(entry.name);
        if (entry.name !== 'manifest.json' && !/^photos\/[a-f0-9]{64}\.jpg$/.test(entry.name))
          throw new Error('Unexpected file in package');
        size += entry.originalSize;
        if (size > PACKAGE_LIMIT || entry.originalSize < 0)
          throw new Error('Expanded package too large');
        return true;
      },
    });
  } catch {
    throw new Error('Invalid or oversized backup package. Nothing was imported.');
  }
  if (!files['manifest.json']) throw new Error('Backup manifest is missing.');
  const result = manifestSchema.safeParse(JSON.parse(strFromU8(files['manifest.json'])));
  if (!result.success)
    throw new Error('Unsupported backup version or invalid metadata. Nothing was imported.');
  const manifest = result.data;
  if (
    new Set(manifest.cards.map((c) => c.id)).size !== manifest.cards.length ||
    new Set(manifest.photos.map((p) => p.hash)).size !== manifest.photos.length
  )
    throw new Error('Backup contains duplicate IDs.');
  const photos: Photo[] = [];
  for (const p of manifest.photos) {
    const bytes = files['photos/' + p.hash + '.jpg'];
    if (!bytes || bytes.length !== p.size || bytes[0] !== 255 || bytes[1] !== 216)
      throw new Error('Photo missing or corrupt. Nothing was imported.');
    const image = new Blob([bytes as Uint8Array<ArrayBuffer>], { type: p.type });
    if ((await photoHash(image)) !== p.hash)
      throw new Error('Photo hash mismatch. Nothing was imported.');
    photos.push({ ...p, bytes: await image.arrayBuffer() });
  }
  if (Object.keys(files).length !== manifest.photos.length + 1)
    throw new Error('Package contains unlisted files.');
  const hashes = new Set(photos.map((p) => p.hash));
  return {
    cards: manifest.cards,
    photos,
    missing: [
      ...new Set(
        manifest.cards
          .flatMap((c) => Object.values(c.photos))
          .filter((h): h is string => !!h && !hashes.has(h)),
      ),
    ],
  };
}
export async function planImport(pack: ImportPackage, database = db): Promise<ImportRow[]> {
  return Promise.all(
    pack.cards.map(async (card) => {
      const old = await database.cards.get(card.id);
      const existing = old ? plainCard(old) : undefined;
      return {
        card,
        existing,
        choice: 'keep',
        kind: existing ? (sameCard(card, existing) ? 'same' : 'different') : 'new',
      };
    }),
  );
}
export async function applyImport(pack: ImportPackage, rows: ImportRow[], database = db) {
  await database.transaction('rw', database.cards, database.photos, database.queue, async () => {
    for (const row of rows) {
      const now = await database.cards.get(row.card.id);
      if (!!now !== !!row.existing || (now && row.existing && !sameCard(now, row.existing)))
        throw new Error(
          'A card changed after this review. Open the package again to review the latest collection.',
        );
    }
    await database.photos.bulkPut(pack.photos);
    for (const row of rows) {
      if (row.kind !== 'new' && (row.kind === 'same' || row.choice === 'keep')) continue;
      const card = row.choice === 'copy' ? copyCard(row.card) : row.card;
      const old = await database.cards.get(card.id);
      const version = (old?.localVersion ?? 0) + 1;
      await database.cards.put({
        ...card,
        baseRev: old?.baseRev ?? 0,
        localVersion: version,
        syncedVersion: old?.syncedVersion ?? 0,
      });
      await database.queue.put({
        id: card.id,
        mutationId: crypto.randomUUID(),
        baseRev: old?.baseRev ?? 0,
        version,
        card,
      });
    }
  });
}
export function csvExport(cards: Card[]) {
  const cell = (s: string) =>
    '"' + (/^[=+@\-\t\r\n]/.test(s) ? "'" + s : s).replace(/"/g, '""') + '"';
  return (
    '\ufeff' +
    [
      [
        'ID',
        'Status',
        ...fields.map((f) => fieldLabels[f]),
        'Front photo SHA-256',
        'Back photo SHA-256',
      ],
      ...cards.map((c) => [
        c.id,
        c.status,
        ...fields.map((f) => c.fields[f]),
        c.photos.front || '',
        c.photos.back || '',
      ]),
    ]
      .map((row) => row.map(cell).join(','))
      .join('\r\n')
  );
}
export async function download(blob: Blob, name: string, share = false) {
  const file = new File([blob], name, { type: blob.type });
  if (share && navigator.canShare?.({ files: [file] })) {
    await navigator.share({ files: [file], title: 'Card Cabinet backup' });
    return;
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
