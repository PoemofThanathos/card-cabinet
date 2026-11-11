import { db, type CabinetDB, type Photo, makePhoto, saveCard, setting } from './db';
import { type Card, type Field, newCard, cardSchema, sameCard } from './model';
import { groupKey } from './groups';
import { transformPhoto } from './photos';

export type PairOrder = 'alternating' | 'fronts-first';
export type FileReference = { name: string; size: number; lastModified: number };
export type PhotoPair = [File, File];
export type NumberRange = [number, number];
export type OwnershipMode = 'complete' | 'missing' | 'owned';
export type BulkEntry = {
  card: Card;
  sources?: [FileReference, FileReference];
  state: 'pending' | 'saved' | 'existing' | 'skipped';
};
export type BulkEntryPlan = {
  id: string;
  kind: 'photos' | 'manual' | 'base';
  entries: BulkEntry[];
  identifyAfterSaving?: boolean;
};
export const bulkEntryKey = 'bulkEntryDraft';
const normalized = (value: string) => value.normalize('NFKC').trim().toLocaleLowerCase();
export const fileKey = (file: FileReference) =>
  JSON.stringify([file.name, file.size, file.lastModified]);
export const fileReference = (file: File): FileReference => ({
  name: file.name,
  size: file.size,
  lastModified: file.lastModified,
});

export function pairPhotos(files: File[], order: PairOrder): PhotoPair[] {
  validateSourceFiles(files);
  if (files.length % 2)
    throw new Error('Choose an even number of photos, one front and one back per card.');
  const sorted = [...files].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }),
  );
  const pairs: PhotoPair[] = [];
  const half = sorted.length / 2;
  for (let i = 0; i < half; i++)
    pairs.push(
      order === 'alternating' ? [sorted[i * 2], sorted[i * 2 + 1]] : [sorted[i], sorted[i + half]],
    );
  return pairs;
}

export function validateSourceFiles(files: File[]) {
  const keys = new Set<string>();
  for (const file of files) {
    const key = fileKey(file);
    if (keys.has(key))
      throw new Error(
        `Two selected photos have the same filename, size and date: ${file.name}. Rename one file before importing.`,
      );
    keys.add(key);
  }
}

export function parseNumberRanges(text: string): NumberRange[] {
  if (!text.trim()) return [];
  const ranges = text
    .trim()
    .replace(/[–—]/g, '-')
    .replace(/\s*-\s*/g, '-')
    .split(/[\s,;]+/)
    .map((part) => {
      const match = /^(\d+)(?:-(\d+))?$/.exec(part);
      if (!match) throw new Error('Use card numbers and ranges, such as 1-350 or 2, 7, 147.');
      const start = Number(match[1]),
        end = Number(match[2] ?? match[1]);
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start)
        throw new Error('Each range must run from a smaller whole number to a larger one.');
      return [start, end] as NumberRange;
    })
    .sort((a, b) => a[0] - b[0]);
  const merged: NumberRange[] = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (previous && range[0] <= previous[1] + 1) previous[1] = Math.max(previous[1], range[1]);
    else merged.push([...range]);
  }
  if (!Number.isSafeInteger(numberCount(merged))) throw new Error('The number range is too large.');
  return merged;
}
export const numberCount = (ranges: NumberRange[]) =>
  ranges.reduce((n, [a, b]) => n + b - a + 1, 0);
export function* cardNumbers(ranges: NumberRange[]) {
  for (const [start, end] of ranges)
    for (let n = start; n <= end; n++) {
      yield String(n);
      if (n === Number.MAX_SAFE_INTEGER) break;
    }
}
export function subtractNumbers(ranges: NumberRange[], remove: NumberRange[]): NumberRange[] {
  const result: NumberRange[] = [];
  for (const [start, end] of ranges) {
    let next = start;
    for (const [a, b] of remove) {
      if (b < next) continue;
      if (a > end) break;
      if (a > next) result.push([next, a - 1]);
      next = Math.max(next, b + 1);
      if (next > end) break;
    }
    if (next <= end) result.push([next, end]);
  }
  return result;
}
export function baseSelection(checklist: string, mode: OwnershipMode, list: string) {
  const all = parseNumberRanges(checklist),
    supplied = mode === 'complete' ? [] : parseNumberRanges(list);
  if (mode !== 'owned' && !all.length)
    throw new Error('Enter the full base checklist number range.');
  if (mode === 'owned' && !supplied.length)
    throw new Error('Enter the base card numbers you have confirmed.');
  if (all.length && subtractNumbers(supplied, all).length)
    throw new Error('A listed card number is outside the base checklist.');
  const owned =
    mode === 'complete' ? all : mode === 'missing' ? subtractNumbers(all, supplied) : supplied;
  return { owned, unrecorded: all.length ? subtractNumbers(all, owned) : null };
}
export function manualRows(text: string): Partial<Record<Field, string>>[] {
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line, index) => {
      const values = line.split(line.includes('\t') ? '\t' : '|').map((value) => value.trim());
      if (values.length > 4)
        throw new Error(
          `Row ${index + 1} has too many columns. Use name, card number, team and rarity.`,
        );
      const [name = '', cardNumber = '', team = '', rarity = ''] = values;
      if (!name && !cardNumber) throw new Error(`Row ${index + 1} needs a name or card number.`);
      return { name, cardNumber, team, rarity };
    });
}
export function baseCardKey(card: Card) {
  const f = card.fields;
  if (
    card.status === 'deleted' ||
    normalized(f.rarity) !== 'base' ||
    !f.cardNumber.trim() ||
    f.autograph.trim() ||
    f.memorabilia.trim() ||
    f.serial.trim()
  )
    return null;
  const normalizedNumber = normalized(f.cardNumber);
  const number = /^\d+$/.test(normalizedNumber)
    ? normalizedNumber.replace(/^0+(?=\d)/, '')
    : normalizedNumber;
  return groupKey(card, 'set') + ':' + number;
}
export function bulkCard(
  common: Partial<Record<Field, string>>,
  row: Partial<Record<Field, string>>,
  base = false,
) {
  const card = newCard();
  card.fields = { ...card.fields, ...common, ...row };
  if (base)
    Object.assign(card.fields, { rarity: 'Base', autograph: '', memorabilia: '', serial: '' });
  return cardSchema.parse(card);
}
export function savedEntryIds(plan: BulkEntryPlan) {
  return plan.entries.filter((entry) => entry.state === 'saved').map((entry) => entry.card.id);
}
type PlanHeader = {
  id: string;
  kind: BulkEntryPlan['kind'];
  count: number;
  identifyAfterSaving?: boolean;
};
const entryPrefix = (id: string) => `bulkEntry:${id}:`;
const entryKey = (id: string, index: number) => entryPrefix(id) + String(index).padStart(16, '0');
export async function getBulkEntryPlan(database = db) {
  const header = await setting<PlanHeader | null>(bulkEntryKey, null, database);
  if (!header) return null;
  const rows = await database.settings.where('key').startsWith(entryPrefix(header.id)).toArray();
  if (rows.length !== header.count)
    throw new Error('The saved import is incomplete. Your collection is still available.');
  return {
    id: header.id,
    kind: header.kind,
    ...(header.identifyAfterSaving ? { identifyAfterSaving: true } : {}),
    entries: rows.map((row) => row.value as BulkEntry),
  };
}
export async function storeBulkEntryPlan(plan: BulkEntryPlan, database = db) {
  await database.transaction('rw', database.settings, async () => {
    const previous = await setting<PlanHeader | null>(bulkEntryKey, null, database);
    if (previous)
      await database.settings.where('key').startsWith(entryPrefix(previous.id)).delete();
    await database.settings.bulkPut(
      plan.entries.map((entry, index) => ({ key: entryKey(plan.id, index), value: entry })),
    );
    await database.settings.put({
      key: bulkEntryKey,
      value: {
        id: plan.id,
        kind: plan.kind,
        count: plan.entries.length,
        ...(plan.identifyAfterSaving ? { identifyAfterSaving: true } : {}),
      } satisfies PlanHeader,
    });
  });
}
export async function deleteBulkEntryPlan(id: string, database = db) {
  await database.transaction('rw', database.settings, async () => {
    const header = await setting<PlanHeader | null>(bulkEntryKey, null, database);
    if (header?.id !== id) throw new Error('This import changed in another tab. Reopen Bulk add.');
    await database.settings.where('key').startsWith(entryPrefix(id)).delete();
    await database.settings.delete(bulkEntryKey);
  });
}

export async function changeBulkEntry(
  planId: string,
  index: number,
  action: 'swap' | 'skip',
  database = db,
) {
  return database.transaction('rw', database.settings, async () => {
    const current = await setting<PlanHeader | null>(bulkEntryKey, null, database);
    if (!current || current.id !== planId)
      throw new Error('This import changed in another tab. Reopen Bulk add.');
    const entry = await setting<BulkEntry | null>(entryKey(planId, index), null, database);
    if (!entry) throw new Error('This import entry is missing. Reopen Bulk add.');
    if (entry.state !== 'pending') return (await getBulkEntryPlan(database))!;
    if (action === 'skip') entry.state = 'skipped';
    else if (entry.sources) entry.sources = [entry.sources[1], entry.sources[0]];
    await database.settings.put({ key: entryKey(planId, index), value: entry });
    return (await getBulkEntryPlan(database))!;
  });
}

/** Each card, its images, queue entry and import progress commit together. */
export async function saveBulkEntry(
  plan: BulkEntryPlan,
  index: number,
  files: Map<string, File>,
  database: CabinetDB = db,
  encode: (blob: Blob) => Promise<Photo> = async (blob) => makePhoto(await transformPhoto(blob)),
) {
  const entry = plan.entries[index];
  if (!entry || entry.state !== 'pending') return plan;
  let card = structuredClone(entry.card);
  const photos: Photo[] = [];
  if (entry.sources) {
    for (const source of entry.sources) {
      const file = files.get(fileKey(source));
      if (!file)
        throw new Error(`Reselect the original photos to continue. Missing file: ${source.name}`);
      photos.push(await encode(file));
    }
    card.photos = { front: photos[0].hash, back: photos[1].hash };
  }
  let state: BulkEntry['state'] = 'saved';
  await database.transaction(
    'rw',
    database.cards,
    database.photos,
    database.queue,
    database.settings,
    async () => {
      const current = await setting<PlanHeader | null>(bulkEntryKey, null, database);
      if (!current || current.id !== plan.id)
        throw new Error('This import changed in another tab. Reopen Bulk add.');
      const currentEntry = await setting<BulkEntry | null>(
        entryKey(plan.id, index),
        null,
        database,
      );
      if (!currentEntry) throw new Error('This import entry is missing. Reopen Bulk add.');
      if (currentEntry.state !== 'pending') {
        state = currentEntry.state;
        card = currentEntry.card;
        return;
      }
      if (
        !sameCard(currentEntry.card, entry.card) ||
        JSON.stringify(currentEntry.sources) !== JSON.stringify(entry.sources)
      )
        throw new Error(
          'This card or its photo pairing changed in another tab. Reopen Bulk add before saving it.',
        );
      if (await database.cards.get(card.id)) state = 'existing';
      else if (plan.kind === 'base') {
        const key = baseCardKey(card);
        const exists = await database.cards.filter((saved) => baseCardKey(saved) === key).first();
        if (exists) state = 'existing';
      }
      if (state === 'saved') await saveCard(card, photos, database);
      await database.settings.put({
        key: entryKey(plan.id, index),
        value: { ...currentEntry, card, state },
      });
    },
  );
  return {
    ...plan,
    entries: plan.entries.map((item, i) => (i === index ? { ...item, card, state } : item)),
  };
}
