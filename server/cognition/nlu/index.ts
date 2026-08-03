import { NlpManager } from 'node-nlp';
import { NLUResult, IntentCategory } from './intents';

const manager = new NlpManager({ languages: ['zh'] });

export async function loadNLUModel() {
  await manager.load('/app/data/models/nlu-model.nlp');
}

export async function parseIntent(text: string): Promise<NLUResult> {
  const response = await manager.process('zh', text);
  const intent = response.intent as IntentCategory;
  const confidence = response.score;
  const entities = response.entities.reduce((acc: Record<string, any>, cur: any) => {
    acc[cur.entity] = cur.resolution?.value || cur.utteranceText;
    return acc;
  }, {});
  return { intent, entities, confidence, source: 'node-nlp' };
}
