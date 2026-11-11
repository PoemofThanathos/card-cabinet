import { db, type CabinetDB, type Photo, makePhoto, setting } from './db';
import {
  type Card,
  type Field,
  type LocalCard,
  type Operation,
  newCard,
  cardSchema,
  sameCard,
  purgedCard,
  plainCard,
} from './model';
import { groupKey } from './groups';
import { transformPhoto, fullCrop, photoProcessingCapabilities } from './photos';
import { type ProcessingSpeed, normalizeProcessingSpeed, speedProfiles } from './processing-speed';

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
    card.status === 'purged' ||
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
  return plan.entries
    .filter((entry) => entry.state === 'saved' && entry.card.status !== 'purged')
    .map((entry) => entry.card.id);
}
type PlanHeader = {
  id: string;
  kind: BulkEntryPlan['kind'];
  count: number;
  identifyAfterSaving?: boolean;
};
const entryPrefix = (id: string) => `bulkEntry:${id}:`;
const entryKey = (id: string, index: number) => entryPrefix(id) + String(index).padStart(16, '0');
/** Bulk progress and purge checks must share the same transaction scope. */
export function withBulkEntryTransaction<T>(action: () => Promise<T>, database = db) {
  return database.transaction('rw', database.settings, database.cards, action);
}
function availableEntry(entry: BulkEntry, current?: Card): BulkEntry {
  return current?.status === 'purged' || entry.card.status === 'purged'
    ? { card: purgedCard(current?.status === 'purged' ? current : entry.card), state: 'skipped' }
    : entry;
}
export async function getBulkEntryPlan(database = db) {
  const header = await setting<PlanHeader | null>(bulkEntryKey, null, database);
  if (!header) return null;
  const rows = await database.settings.where('key').startsWith(entryPrefix(header.id)).toArray();
  if (rows.length !== header.count)
    throw new Error('The saved import is incomplete. Your collection is still available.');
  const current = await database.cards.bulkGet(rows.map((row) => (row.value as BulkEntry).card.id));
  return {
    id: header.id,
    kind: header.kind,
    ...(header.identifyAfterSaving ? { identifyAfterSaving: true } : {}),
    entries: rows
      .map((row) => row.value as BulkEntry)
      .map((entry, index) => availableEntry(entry, current[index])),
  };
}
export async function storeBulkEntryPlan(plan: BulkEntryPlan, database = db) {
  await withBulkEntryTransaction(async () => {
    const previous = await setting<PlanHeader | null>(bulkEntryKey, null, database);
    if (previous)
      await database.settings.where('key').startsWith(entryPrefix(previous.id)).delete();
    const current = await database.cards.bulkGet(plan.entries.map((entry) => entry.card.id));
    const entries = plan.entries.map((entry, index) => availableEntry(entry, current[index]));
    await database.settings.bulkPut(
      entries.map((entry, index) => ({ key: entryKey(plan.id, index), value: entry })),
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
  }, database);
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
  return withBulkEntryTransaction(async () => {
    const current = await setting<PlanHeader | null>(bulkEntryKey, null, database);
    if (!current || current.id !== planId)
      throw new Error('This import changed in another tab. Reopen Bulk add.');
    let entry = await setting<BulkEntry | null>(entryKey(planId, index), null, database);
    if (!entry) throw new Error('This import entry is missing. Reopen Bulk add.');
    entry = availableEntry(entry, await database.cards.get(entry.card.id));
    if (entry.card.status === 'purged')
      await database.settings.put({ key: entryKey(planId, index), value: entry });
    if (entry.state !== 'pending') return (await getBulkEntryPlan(database))!;
    if (action === 'skip') entry.state = 'skipped';
    else if (entry.sources) {
      entry.sources = [entry.sources[1], entry.sources[0]];
      entry.card.photos = { front: entry.card.photos.back, back: entry.card.photos.front };
    }
    await database.settings.put({ key: entryKey(planId, index), value: entry });
    return (await getBulkEntryPlan(database))!;
  }, database);
}

type EncodePhoto = (blob: Blob) => Promise<Photo>;
type PreparedEntry = { index: number; expected: BulkEntry; card: Card; photos: Photo[] };

async function prepareEntry(
  entry: BulkEntry,
  index: number,
  files: Map<string, File>,
  encode: EncodePhoto,
): Promise<PreparedEntry> {
  const expected = structuredClone(entry);
  const card = structuredClone(expected.card);
  const photos: Photo[] = [];
  if (expected.sources) {
    for (const [side, source] of expected.sources.entries()) {
      const file = files.get(fileKey(source));
      if (!file)
        throw new Error(`Reselect the original photos to continue. Missing file: ${source.name}`);
      const savedHash = expected.card.photos[side ? 'back' : 'front'];
      const local = savedHash && file.type === 'image/jpeg' ? await makePhoto(file) : null;
      photos.push(local?.hash === savedHash ? local! : await encode(file));
    }
    card.photos = { front: photos[0].hash, back: photos[1].hash };
  }
  return { index, expected, card, photos };
}

class EntryCommitError extends Error {
  constructor(
    message: string,
    public index: number,
  ) {
    super(message);
  }
}

/** A card, its photos, sync operation and progress always commit together. */
async function commitEntries(plan: BulkEntryPlan, prepared: PreparedEntry[], database: CabinetDB) {
  return database.transaction(
    'rw',
    database.cards,
    database.photos,
    database.queue,
    database.settings,
    async () => {
      const current = await setting<PlanHeader | null>(bulkEntryKey, null, database);
      if (!current || current.id !== plan.id || current.kind !== plan.kind)
        throw new Error('This import changed in another tab. Reopen Bulk add.');
      const stored = await database.settings.bulkGet(
        prepared.map(({ index }) => entryKey(plan.id, index)),
      );
      const existing = await database.cards.bulkGet(prepared.map(({ card }) => card.id));
      const baseKeys = new Set<string>();
      if (plan.kind === 'base')
        await database.cards.each((card) => {
          const key = baseCardKey(card);
          if (key) baseKeys.add(key);
        });
      const cards: LocalCard[] = [];
      const operations: Operation[] = [];
      const photos = new Map<string, Photo>();
      const changes = new Map<number, BulkEntry>();
      const written = new Map<string, LocalCard>();
      const timestamp = new Date().toISOString();
      for (const [offset, item] of prepared.entries()) {
        const currentEntry = stored[offset]?.value as BulkEntry | undefined;
        if (!currentEntry)
          throw new EntryCommitError('This import entry is missing. Reopen Bulk add.', item.index);
        const prior = existing[offset] ?? written.get(item.card.id);
        const safe = availableEntry(currentEntry, prior);
        if (safe.state !== 'pending') {
          changes.set(item.index, safe);
          continue;
        }
        if (
          !sameCard(currentEntry.card, item.expected.card) ||
          JSON.stringify(currentEntry.sources) !== JSON.stringify(item.expected.sources)
        )
          throw new EntryCommitError(
            'This card or its photo pairing changed in another tab. Reopen Bulk add before saving it.',
            item.index,
          );
        const card = cardSchema.parse({ ...item.card, updatedAt: timestamp });
        if (card.status === 'purged') {
          changes.set(item.index, { card: purgedCard(card), state: 'skipped' });
          continue;
        }
        const key = plan.kind === 'base' ? baseCardKey(card) : null;
        const state = prior || (key && baseKeys.has(key)) ? 'existing' : 'saved';
        changes.set(item.index, { ...currentEntry, card: prior ? plainCard(prior) : card, state });
        if (state === 'existing') continue;
        const local = { ...card, baseRev: 0, localVersion: 1, syncedVersion: 0 };
        cards.push(local);
        written.set(card.id, local);
        operations.push({
          id: card.id,
          mutationId: crypto.randomUUID(),
          baseRev: 0,
          version: 1,
          card,
        });
        for (const photo of item.photos) photos.set(photo.hash, photo);
        if (key) baseKeys.add(key);
      }
      if (photos.size) await database.photos.bulkPut([...photos.values()]);
      if (cards.length) await database.cards.bulkPut(cards);
      if (operations.length) await database.queue.bulkPut(operations);
      await database.settings.bulkPut(
        [...changes].map(([index, value]) => ({ key: entryKey(plan.id, index), value })),
      );
      return changes;
    },
  );
}

function applyChanges(plan: BulkEntryPlan, changes: Map<number, BulkEntry>): BulkEntryPlan {
  return {
    ...plan,
    entries: plan.entries.map((item, index) => changes.get(index) ?? item),
  };
}

export async function saveBulkEntry(
  plan: BulkEntryPlan,
  index: number,
  files: Map<string, File>,
  database: CabinetDB = db,
  encode: EncodePhoto = async (blob) => makePhoto(await transformPhoto(blob)),
) {
  const entry = plan.entries[index];
  if (!entry || entry.state !== 'pending') return plan;
  return applyChanges(
    plan,
    await commitEntries(plan, [await prepareEntry(entry, index, files, encode)], database),
  );
}

export function localImportCapabilities(speed: ProcessingSpeed) {
  const requestedConcurrency = speedProfiles[normalizeProcessingSpeed(speed)].concurrency;
  const capabilities = photoProcessingCapabilities();
  const photoConcurrency = Math.min(requestedConcurrency, capabilities.maxConcurrency);
  return {
    requestedConcurrency,
    photoConcurrency,
    heicConcurrency: 1 as const,
    memoryBudgetMiB: capabilities.memoryBudgetMiB,
    note:
      photoConcurrency < requestedConcurrency
        ? `This device supports up to ${photoConcurrency} photo conversions at once. HEIC and large photos stay sequential.`
        : 'HEIC and large photos stay sequential. JPEG/PNG concurrency adjusts to available memory.',
  };
}
export class BulkSaveError extends Error {
  constructor(
    message: string,
    public plan: BulkEntryPlan,
    public index: number,
  ) {
    super(message);
    this.name = 'BulkSaveError';
  }
}
export type BulkSaveOptions = {
  speed: ProcessingSpeed;
  database?: CabinetDB;
  signal?: AbortSignal;
  onProgress?: (plan: BulkEntryPlan, index: number) => void;
  encode?: EncodePhoto;
};

/** Abort stops new work. Already-started photos finish, commit and report their progress. */
export async function saveBulkEntries(
  plan: BulkEntryPlan,
  files: Map<string, File>,
  options: BulkSaveOptions,
): Promise<BulkEntryPlan> {
  const database = options.database ?? db;
  const speed = normalizeProcessingSpeed(options.speed);
  const concurrency = localImportCapabilities(speed).photoConcurrency;
  const encode =
    options.encode ??
    (async (blob: Blob) =>
      makePhoto(await transformPhoto(blob, 0, fullCrop, 2560, { concurrency })));
  let current = { ...plan, entries: [...plan.entries] };
  const pending = plan.entries
    .map((entry, index) => (entry.state === 'pending' ? index : -1))
    .filter((index) => index >= 0);
  const photoImport = pending.some((index) => !!plan.entries[index].sources);
  const groupSize = photoImport ? 1 : { normal: 1, fast: 16, ultra: 64 }[speed];
  let cursor = 0;
  let failure: { error: unknown; index: number } | undefined;
  const worker = async () => {
    while (!failure && !options.signal?.aborted && cursor < pending.length) {
      const indices = pending.slice(cursor, (cursor += groupSize));
      const index = indices[0];
      try {
        const prepared: PreparedEntry[] = [];
        for (const position of indices)
          prepared.push(await prepareEntry(plan.entries[position], position, files, encode));
        const changes = await commitEntries(plan, prepared, database);
        current = applyChanges(current, changes);
        options.onProgress?.(current, indices.at(-1)!);
      } catch (error) {
        failure ??= { error, index: error instanceof EntryCommitError ? error.index : index };
      }
    }
  };
  await Promise.all(Array.from({ length: photoImport ? concurrency : 1 }, worker));
  if (failure)
    throw new BulkSaveError(
      failure.error instanceof Error ? failure.error.message : 'The import could not finish.',
      current,
      failure.index,
    );
  return current;
}
