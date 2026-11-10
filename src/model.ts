import { z } from 'zod';

export const fieldLabels = {
  category: 'Category',
  product: 'Product',
  name: 'Player or character',
  japaneseName: 'Original Japanese name',
  romanization: 'Romanization',
  team: 'Team or affiliation',
  maker: 'Maker',
  set: 'Set',
  year: 'Year',
  cardNumber: 'Card number',
  language: 'Language',
  rarity: 'Rarity or parallel',
  serial: 'Printed serial number',
  autograph: 'Visible autograph features',
  memorabilia: 'Visible memorabilia features',
  notes: 'Notes',
  tags: 'Tags',
  location: 'Physical location',
  purchaseDate: 'Purchase date',
  purchasePrice: 'Purchase price',
  purchaseCurrency: 'Currency',
  purchaseSource: 'Purchased from',
} as const;
export type Field = keyof typeof fieldLabels;
export const fields = Object.keys(fieldLabels) as Field[];
export const aiFields = fields.filter(
  (f) =>
    ![
      'location',
      'notes',
      'tags',
      'purchaseDate',
      'purchasePrice',
      'purchaseCurrency',
      'purchaseSource',
    ].includes(f),
);
export const categories = ['Japanese baseball', 'MLB', 'Hololive', 'Other'];
export const products = ['Baseball card', 'Hololive Official Card Game', 'Weiss Schwarz', 'Other'];
export const fieldsSchema = z
  .object(
    Object.fromEntries(
      fields.map((k) => [k, z.string().max(k === 'notes' ? 4000 : 300)]),
    ) as Record<Field, z.ZodString>,
  )
  .strict();
export const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const cardSchema = z
  .object({
    id: z.uuid(),
    fields: fieldsSchema,
    photos: z.object({ front: hashSchema.nullable(), back: hashSchema.nullable() }).strict(),
    status: z.enum(['active', 'archived', 'deleted']),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();
export type Card = z.infer<typeof cardSchema>;
export type Draft = { card: Card; base: Card | null };
export const emptyFields = () =>
  Object.fromEntries(fields.map((k) => [k, ''])) as Record<Field, string>;
export const newCard = (): Card => ({
  id: crypto.randomUUID(),
  fields: emptyFields(),
  photos: { front: null, back: null },
  status: 'active',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});
export const sameCard = (a: Card, b: Card) =>
  JSON.stringify([a.id, fields.map((f) => a.fields[f]), a.photos, a.status]) ===
  JSON.stringify([b.id, fields.map((f) => b.fields[f]), b.photos, b.status]);
export const copyCard = (card: Card): Card => ({
  ...structuredClone(card),
  id: crypto.randomUUID(),
  status: 'active',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});
export const title = (c: Card) =>
  c.fields.name || c.fields.japaneseName || c.fields.set || 'Untitled card';
export type LocalCard = Card & { baseRev: number; localVersion: number; syncedVersion: number };
export type Operation = {
  id: string;
  mutationId: string;
  baseRev: number;
  version: number;
  card: Card;
};
export const remoteSchema = z
  .object({ rev: z.number().int().min(1), mutationId: z.uuid(), card: cardSchema })
  .strict();
export type RemoteCard = z.infer<typeof remoteSchema>;
export type Conflict = { id: string; local: Card; remote: RemoteCard };
export const plainCard = (c: Card): Card =>
  cardSchema.parse({
    id: c.id,
    fields: c.fields,
    photos: c.photos,
    status: c.status,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  });
export const suggestionSchema = z
  .object({
    suggestions: z
      .array(
        z
          .object({
            field: z.enum(aiFields as [Field, ...Field[]]),
            value: z.string().max(300),
            source: z.enum(['visible_text', 'inference']),
            evidence: z.string().max(600),
            uncertain: z.boolean(),
          })
          .strict(),
      )
      .max(aiFields.length),
    warnings: z.array(z.string().max(600)).max(8),
  })
  .strict();
export type Suggestions = z.infer<typeof suggestionSchema>;
export function matchCard(c: Card, search: string) {
  return fields
    .map((k) => c.fields[k])
    .join(' ')
    .normalize('NFKC')
    .toLocaleLowerCase()
    .includes(search.normalize('NFKC').toLocaleLowerCase());
}
