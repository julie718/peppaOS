import { loadNLUModel, parseIntent } from './index';

async function test() {
  await loadNLUModel();
  const examples = [
    '你觉得我该不该告诉他',
    '今天天气怎么样',
    '我该不该换城市',
  ];
  for (const text of examples) {
    const result = await parseIntent(text);
    console.log(`输入: "${text}" → 意图: ${result.intent} (置信度: ${result.confidence})`);
  }
}
test().catch(console.error);
