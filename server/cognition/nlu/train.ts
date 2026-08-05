import { NlpManager } from 'node-nlp';
import path from 'path';

const manager = new NlpManager({ languages: ['zh'] });

manager.addDocument('zh', '你觉得我该不该告诉他', 'ask_opinion');
manager.addDocument('zh', '你认为我应该答应他吗', 'ask_opinion');
manager.addDocument('zh', '我该不该换城市', 'ask_opinion');
manager.addDocument('zh', '你觉得我应该怎么做', 'seek_advice');
manager.addDocument('zh', '你觉得我该怎么做', 'seek_advice');
manager.addDocument('zh', '你觉得我应该怎么办', 'seek_advice');
manager.addDocument('zh', '我应该怎么做会更好', 'seek_advice');
manager.addDocument('zh', '我该怎么做比较合适', 'seek_advice');
manager.addDocument('zh', '帮我看一下我该怎么做', 'seek_advice');
manager.addDocument('zh', '你觉得我该怎么判断', 'seek_advice');
manager.addDocument('zh', '你觉得我应该怎么决定', 'seek_advice');
manager.addDocument('zh', '我现在该怎么做', 'seek_advice');
manager.addDocument('zh', '你觉得我现在应该怎么做', 'seek_advice');

manager.addDocument('zh', '今天天气怎么样', 'ask_fact');
manager.addDocument('zh', 'DeepSeek的股价是多少', 'ask_fact');

manager.addDocument('zh', '今天心情不错', 'chat');
manager.addDocument('zh', '我最近有点累', 'chat');

async function train() {
  await manager.train();
  const modelPath = path.join(process.cwd(), 'data', 'models', 'nlu-model.nlp');
  await manager.save(modelPath);
  console.log(`模型训练完成并已保存到 ${modelPath}`);
}

train().catch(console.error);
