import { z } from 'zod';

const text = z.string().max(300);
export const photoAnalysisSchema = z
  .object({
    side: z.enum(['front', 'back', 'unknown']),
    name: text,
    maker: text,
    set: text,
    year: text,
    cardNumber: text,
    variant: text,
    serial: text,
    evidence: z.string().max(600),
    warnings: z.array(text).max(8),
  })
  .strict();
export const photoAnalysisResultSchema = z
  .object({
    photos: z.array(photoAnalysisSchema).min(1).max(2),
  })
  .strict();
export type PhotoAnalysis = z.infer<typeof photoAnalysisSchema>;
export type PhotoAnalysisResult = z.infer<typeof photoAnalysisResultSchema>;
export const photoAnalysisOutputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['photos'],
  properties: {
    photos: {
      type: 'array',
      minItems: 1,
      maxItems: 2,
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'side',
          'name',
          'maker',
          'set',
          'year',
          'cardNumber',
          'variant',
          'serial',
          'evidence',
          'warnings',
        ],
        properties: {
          side: { type: 'string', enum: ['front', 'back', 'unknown'] },
          ...Object.fromEntries(
            ['name', 'maker', 'set', 'year', 'cardNumber', 'variant', 'serial'].map((key) => [
              key,
              { type: 'string', maxLength: 300 },
            ]),
          ),
          evidence: { type: 'string', maxLength: 600 },
          warnings: { type: 'array', maxItems: 8, items: { type: 'string', maxLength: 300 } },
        },
      },
    },
  },
};
