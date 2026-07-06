/**
 * LLM-driven pixel music scene generator.
 * Inputs emotional state + memories + time + track → outputs a MusicScene for the frontend.
 */
import { loadEmotionalState } from '../personality/state';
import { queryMemories } from '../memory/store';
import { getTimeOfDay } from '../time/utils';
import { getMessagesForAgent } from '../conversation/manager';
import { makeLLMCall, NormalizedMessage } from '../llm/providers';
import { getKey } from '../config/keys';

export interface MusicScene {
  colors: { bg: string; primary: string; secondary: string; accent: string };
  scene: string;
  particles: string;
  lyricsStyle: string;
  intensity: number;
  reason: string;
  terrainColors?: string[];
  emotion?: { valence: number; arousal: number };
}

const SCENE_PROMPT = `你是 Peppa 的像素视觉引擎。根据主人的状态生成一个像素风音乐氛围场景。输出严格 JSON，不要其他文字。

输入：
- 情绪：valence(愉悦-1~1) arousal(活跃0~1) dominantMood(主导心情) energy(精力0~1) connection(亲密度0~1)
- 时段：morning/afternoon/evening/night
- 记忆：用户偏好/习惯片段
- 歌曲：歌名+歌手
- 对话：最近聊了什么

输出 JSON 格式：
{
  "colors": { "bg": "#hex暗底色", "primary": "#hex主色", "secondary": "#hex辅色", "accent": "#hex强调色" },
  "scene": "像素场景名(英文单词): festival/starlight/sakura/neon/retrowave/rain/void/forest/cosmos/crystal/sunset/ember/drift/oldtown",
  "particles": "粒子类型: stars/fireflies/rain/hearts/sparks/petals/snow/dust/none",
  "lyricsStyle": "歌词风格: bubble/dissolve/typewriter/scatter/wave/pixel",
  "intensity": 0.1到1.0(0=极慢梦幻,1=活跃跳动),
  "reason": "一句像素风中文推荐语(20字内,用情绪对应,像游戏提示框文字)",
  "terrainColors": ["#hex地形色1","#hex地形色2","#hex地形色3","#hex地形色4"]
}

规则：
- 开心/兴奋→暖色(金/橙/粉), 活跃粒子(fireflies/hearts/sparks), 节奏快
- 忧伤/疲惫→冷色(蓝/紫/靛), 安静粒子(rain/dust/snow), 节奏慢
- 沉思/专注→暗色+单点强调色, 极简粒子(none/stars)
- 夜晚→更深暗底, 时段影响色调
- 像素风配色要有霓虹感，非纯色，带数字感的 hex`;

export async function generateMusicScene(
  userId: string,
  trackInfo: { name: string; artists: string[] },
  mood: string,
  provider: 'deepseek' | 'gemini' | 'openai' | 'anthropic' | 'qwen' | 'ark' | 'ollama' | 'lmstudio' | 'auto' = 'deepseek',
  model: string = 'deepseek-chat',
  llmGetters?: {
    getDeepSeek: () => any;
    getGemini: () => any;
  },
): Promise<MusicScene | null> {
  try {
    const es = loadEmotionalState(userId);
    const timeOfDay = getTimeOfDay(userId) || 'afternoon';

    // Get 3 most relevant memories about music/mood/preferences
    const memories = queryMemories({
      userId,
      query: `音乐 喜好 心情 ${mood}`,
      type: 'preference',
      limit: 3,
    });
    const memorySnippets = memories.map(m => m.content || m.keywords?.join(' ')).filter(Boolean).slice(0, 3);

    // Get last 2 conversation messages for context
    let recentTalk = '';
    try {
      const msgs = getMessagesForAgent(userId, '', 2);
      recentTalk = msgs.map(m => m.message).join(' | ');
    } catch {}

    const promptInput = `情绪: valence=${es.valence.toFixed(2)} arousal=${es.arousal.toFixed(2)} dominantMood=${es.dominantMood || mood} energy=${es.energy.toFixed(2)} connection=${es.connection.toFixed(2)}
时段: ${timeOfDay}
记忆: ${memorySnippets.join('; ') || '无特定记忆'}
歌曲: ${trackInfo.name} - ${trackInfo.artists.join('/')}
对话: ${recentTalk || '无最近对话'}`;

    const messages: NormalizedMessage[] = [
      { role: 'system', content: SCENE_PROMPT },
      { role: 'user', content: promptInput },
    ];

    const getDeepSeek = llmGetters?.getDeepSeek || (() => {
      const key = getKey('DEEPSEEK_API_KEY') || process.env.DEEPSEEK_API_KEY || '';
      const { default: OpenAI } = require('openai');
      return new OpenAI({ apiKey: key, baseURL: 'https://api.deepseek.com' });
    });

    const getGemini = llmGetters?.getGemini || (() => {
      throw new Error('Gemini not available');
    });

    const result = await makeLLMCall(
      messages,
      [],
      { provider, model, maxTokens: 150, userId },
      getDeepSeek,
      getGemini,
    );

    const text = result.text || '';
    // Extract JSON from response
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.warn('[SceneGenerator] No JSON in response:', text.slice(0, 100));
      return null;
    }

    const scene: MusicScene = JSON.parse(jsonMatch[0]);
    if (!scene.colors?.bg || !scene.colors?.accent || !scene.scene) {
      console.warn('[SceneGenerator] Missing required fields:', scene);
      return null;
    }
    // Inject emotion data for frontend lyric coloring
    scene.emotion = { valence: es.valence, arousal: es.arousal };

    console.log(`[SceneGenerator] Generated scene: ${scene.scene}, particles: ${scene.particles}, intensity: ${scene.intensity}`);
    return scene;
  } catch (e: any) {
    console.warn('[SceneGenerator] Failed, using fallback:', e.message);
    return null;
  }
}

/**
 * Fallback scene when LLM fails — uses pixel mood mapping similar to current static version.
 */
export function getFallbackScene(mood: string, es?: { valence: number; arousal: number }): MusicScene {
  const e = es || { valence: 0.3, arousal: 0.5 };
  const map: Record<string, MusicScene> = {
    happy:    { colors: { bg: '#1a0f2e', primary: '#ffcc00', secondary: '#ff9500', accent: '#ffcc00' }, scene: 'festival', particles: 'fireflies', lyricsStyle: 'bubble', intensity: 0.7, reason: '像素庆典，为你点亮！', terrainColors: ['#ffcc00','#ff9500','#ff6b9d','#c44dff'], emotion: e },
    warm:     { colors: { bg: '#1a0d08', primary: '#ff8c42', secondary: '#ffb566', accent: '#ff8c42' }, scene: 'sunset', particles: 'petals', lyricsStyle: 'bubble', intensity: 0.5, reason: '晚霞余晖，温暖如你。', terrainColors: ['#ff8c42','#ff6b35','#ffb566','#ffd700'], emotion: e },
    playful:  { colors: { bg: '#0f0a1f', primary: '#c77dff', secondary: '#f72585', accent: '#c77dff' }, scene: 'neon', particles: 'sparks', lyricsStyle: 'scatter', intensity: 0.8, reason: '像素街机已就绪！', terrainColors: ['#c77dff','#7b2ff7','#f72585','#4cc9f0'], emotion: e },
    excited:  { colors: { bg: '#1a0505', primary: '#ff3333', secondary: '#ff6600', accent: '#ff3333' }, scene: 'festival', particles: 'sparks', lyricsStyle: 'wave', intensity: 0.9, reason: '烟花炸裂，燃起来了！', terrainColors: ['#ff3333','#ff6600','#ffcc00','#ff0066'], emotion: e },
    calm:     { colors: { bg: '#050d14', primary: '#4fc3f7', secondary: '#0288d1', accent: '#4fc3f7' }, scene: 'cosmos', particles: 'stars', lyricsStyle: 'dissolve', intensity: 0.3, reason: '星海沉静，放空片刻。', terrainColors: ['#4fc3f7','#0288d1','#80deea','#b2ebf2'], emotion: e },
    peaceful: { colors: { bg: '#080a0f', primary: '#90a4ae', secondary: '#546e7a', accent: '#90a4ae' }, scene: 'cosmos', particles: 'stars', lyricsStyle: 'dissolve', intensity: 0.25, reason: '月下静谧，像素星尘。', terrainColors: ['#90a4ae','#546e7a','#78909c','#b0bec5'], emotion: e },
    contemplative: { colors: { bg: '#0a0814', primary: '#7c4dff', secondary: '#536dfe', accent: '#7c4dff' }, scene: 'cosmos', particles: 'stars', lyricsStyle: 'dissolve', intensity: 0.3, reason: '深空遐想，思绪飘远。', terrainColors: ['#7c4dff','#536dfe','#448aff','#b388ff'], emotion: e },
    sad:      { colors: { bg: '#050810', primary: '#42a5f5', secondary: '#1e88e5', accent: '#42a5f5' }, scene: 'rain', particles: 'rain', lyricsStyle: 'typewriter', intensity: 0.2, reason: '像素雨滴，轻柔陪伴。', terrainColors: ['#42a5f5','#1e88e5','#5c6bc0','#7986cb'], emotion: e },
    melancholic: { colors: { bg: '#0a0610', primary: '#ab47bc', secondary: '#7b1fa2', accent: '#ab47bc' }, scene: 'oldtown', particles: 'dust', lyricsStyle: 'typewriter', intensity: 0.2, reason: '回忆像素化，温柔褪色。', terrainColors: ['#ab47bc','#7b1fa2','#9c27b0','#ce93d8'], emotion: e },
    tired:    { colors: { bg: '#0a0810', primary: '#9575cd', secondary: '#7e57c2', accent: '#9575cd' }, scene: 'drift', particles: 'dust', lyricsStyle: 'dissolve', intensity: 0.15, reason: '像素漂流，好好休息。', terrainColors: ['#9575cd','#7e57c2','#5c6bc0','#b39ddb'], emotion: e },
    focused:  { colors: { bg: '#040a08', primary: '#66bb6a', secondary: '#43a047', accent: '#66bb6a' }, scene: 'forest', particles: 'none', lyricsStyle: 'pixel', intensity: 0.3, reason: '像素森林，专注守护。', terrainColors: ['#66bb6a','#43a047','#2e7d32','#a5d6a7'], emotion: e },
    curious:  { colors: { bg: '#041010', primary: '#26c6da', secondary: '#00acc1', accent: '#26c6da' }, scene: 'crystal', particles: 'sparks', lyricsStyle: 'scatter', intensity: 0.6, reason: '探索未知像素世界！', terrainColors: ['#26c6da','#00acc1','#0097a7','#80deea'], emotion: e },
    nostalgic: { colors: { bg: '#100a04', primary: '#ffab40', secondary: '#ff9100', accent: '#ffab40' }, scene: 'oldtown', particles: 'petals', lyricsStyle: 'bubble', intensity: 0.4, reason: '像素旧时光，温暖再现。', terrainColors: ['#ffab40','#ff9100','#ff6d00','#ffd54f'], emotion: e },
  };
  return { ...(map[mood] || map.peaceful), emotion: e };
}
