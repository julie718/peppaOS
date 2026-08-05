import { NlpManager } from 'node-nlp';
import { NLUResult, IntentCategory } from './intents';

const MODEL_PATH = process.env.NLU_MODEL_PATH || '/app/data/models/nlu-model.nlp';
const manager = new NlpManager({ languages: ['zh'] });
let isLoaded = false;

export async function loadNLUModel() {
  if (isLoaded) return;
  await manager.load(MODEL_PATH);
  isLoaded = true;
}

export async function parseIntent(text: string): Promise<NLUResult> {
  if (!isLoaded) {
    await loadNLUModel();
  }

  const response = await manager.process('zh', text);
  const intent = response.intent as IntentCategory;
  const confidence = response.score;
  const entities = (response.entities || []).reduce((acc: Record<string, any>, cur: any) => {
    acc[cur.entity] = cur.resolution?.value || cur.utteranceText;
    return acc;
  }, {});
  return { intent, entities, confidence, source: 'node-nlp' };
}
