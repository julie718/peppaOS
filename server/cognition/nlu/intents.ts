export const INTENT_CATEGORIES = {
  ASK_OPINION: 'ask_opinion',
  SEEK_ADVICE: 'seek_advice',
  ASK_FACT: 'ask_fact',
  CHAT: 'chat',
} as const;

export type IntentCategory = typeof INTENT_CATEGORIES[keyof typeof INTENT_CATEGORIES];

export interface NLUResult {
  intent: IntentCategory;
  entities: Record<string, any>;
  confidence: number;
  source: string;
}
