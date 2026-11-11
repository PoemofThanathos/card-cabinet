export const processingSpeeds = ['normal', 'fast', 'ultra'] as const;
export type ProcessingSpeed = (typeof processingSpeeds)[number];
export const speedProfiles = {
  normal: { label: 'Normal', concurrency: 1, delayMs: 15000 },
  fast: { label: 'Fast', concurrency: 2, delayMs: 0 },
  ultra: { label: 'Ultra fast', concurrency: 4, delayMs: 0 },
} as const;

export function normalizeProcessingSpeed(value: unknown): ProcessingSpeed {
  return processingSpeeds.includes(value as ProcessingSpeed)
    ? (value as ProcessingSpeed)
    : 'normal';
}

export const processingSpeedKey = 'processingSpeed';
