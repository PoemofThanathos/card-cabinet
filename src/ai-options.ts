export const aiModels = ['gpt-6-luna', 'gpt-6.1-terra', 'gpt-6.1-sol', 'gpt-6-astra'] as const;
export const reasoningEfforts = ['low', 'medium', 'high'] as const;
export type AIModel = (typeof aiModels)[number];
export type ReasoningEffort = (typeof reasoningEfforts)[number];
export type IdentificationOptions = { model: AIModel; reasoningEffort: ReasoningEffort };

export const modelLabels: Record<AIModel, string> = {
  'gpt-6-luna': 'GPT-6 Luna',
  'gpt-6.1-terra': 'GPT-6.1 Terra',
  'gpt-6.1-sol': 'GPT-6.1 Sol',
  'gpt-6-astra': 'GPT-6 Astra',
};
export const reasoningLabels: Record<ReasoningEffort, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
};
export const defaultIdentificationOptions: IdentificationOptions = {
  model: 'gpt-6-luna',
  reasoningEffort: 'low',
};
export const aiRequestTimeoutMs = 120000;
export const aiClientTimeoutMs = 135000;
export const aiLeaseMs = 150000;
export const outputTokenLimits: Record<ReasoningEffort, number> = {
  low: 2500,
  medium: 6000,
  high: 10000,
};

export function normalizeIdentificationOptions(value: unknown): IdentificationOptions {
  const input = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  return {
    model: aiModels.includes(input.model as AIModel)
      ? (input.model as AIModel)
      : defaultIdentificationOptions.model,
    reasoningEffort: reasoningEfforts.includes(input.reasoningEffort as ReasoningEffort)
      ? (input.reasoningEffort as ReasoningEffort)
      : defaultIdentificationOptions.reasoningEffort,
  };
}

export function identificationLabel(options: IdentificationOptions) {
  return `${modelLabels[options.model]} · ${reasoningLabels[options.reasoningEffort]} reasoning`;
}
