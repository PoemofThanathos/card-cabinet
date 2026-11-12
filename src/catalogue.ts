import { z } from 'zod';
import type { Card } from './model';

export const identityKeys = [
  'name',
  'japaneseName',
  'maker',
  'set',
  'year',
  'cardNumber',
  'rarity',
] as const;
export const identitySchema = z
  .object(
    Object.fromEntries(identityKeys.map((k) => [k, z.string().max(300)])) as Record<
      (typeof identityKeys)[number],
      z.ZodString
    >,
  )
  .strict();
export type CatalogueIdentity = z.infer<typeof identitySchema>;
export const catalogueResultSchema = z
  .object({
    candidates: z
      .array(
        z
          .object({
            title: z.string().max(300),
            sourceUrl: z.url(),
            imageUrl: z.url().nullable(),
            exactness: z.enum(['exact', 'variant_uncertain', 'unconfirmed']),
          })
          .strict(),
      )
      .max(5),
  })
  .strict();
export type CatalogueResult = z.infer<typeof catalogueResultSchema>;
export function catalogueIdentity(fields: Card['fields']): CatalogueIdentity {
  return identitySchema.parse(Object.fromEntries(identityKeys.map((k) => [k, fields[k]])));
}
export function identityFingerprint(identity: CatalogueIdentity) {
  return JSON.stringify(identityKeys.map((k) => identity[k].trim()));
}

export function advanceIdentity(
  current: { fingerprint: string; generation: number },
  fingerprint: string,
) {
  return current.fingerprint === fingerprint
    ? current
    : { fingerprint, generation: current.generation + 1 };
}
export function isCurrentLookup(current: { generation: number }, started: number) {
  return current.generation === started;
}
