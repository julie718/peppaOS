// ACI 预判式上下文注入 — 在用户可能发消息前提前预取相关信息
import { queryMemories } from './store.js';
import { logger } from '../lib/logger.js';

interface PrefetchedData {
  schedule: string | null;        // 今日日程摘要
  weather: string | null;         // 天气信息
  recentConversation: string | null; // 最近对话摘要
  sceneMemories: string[];       // 场景相关记忆
  prefetchedAt: number;          // 预取时间戳
  ttl: number;                   // 有效期
}

interface PrefetchedContext {
  summary: string;               // 可注入 systemPrompt 的文本
  source: string;                // 来源标识
}

// 内存缓存：按 uid 存储
const store = new Map<string, PrefetchedData>();
const DEFAULT_TTL = 10 * 60000; // 10 分钟

/** 场景标签映射 */
const SCENE_LABELS: Record<string, string> = {
  home: '家', office: '公司', commute: '通勤', sleep: '睡眠',
};

/** 判断是否在早晨窗口 */
function isMorningWindow(): boolean {
  const hour = new Date().getHours();
  return hour >= 7 && hour <= 9;
}

/** 判断是否在空闲预判窗口 */
let lastActivityTime = Date.now();
export function touchActivity(): void {
  lastActivityTime = Date.now();
}
function isIdleWindow(): boolean {
  return (Date.now() - lastActivityTime) > 5 * 60000;
}

/** 获取当日日期字符串 */
function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

/** 提取话题关键词 */
function extractTopics(text: string): string[] {
  const keywords = [
    '健康', '工作', '股票', '天气', '出行', '美食', '音乐', '电影',
    '学习', '读书', '运动', '旅行', '购物', '科技', 'AI',
    'health', 'work', 'stock', 'weather', 'travel', 'food', 'music',
  ];
  const lower = text.toLowerCase();
  return keywords.filter(k => lower.includes(k));
}

/** 执行预判 */
export async function prefetchContext(
  uid: string,
  options?: {
    scene?: string;
    forceRefresh?: boolean;
  },
): Promise<PrefetchedData | null> {
  // 检查是否有有效缓存
  const cached = store.get(uid);
  if (cached && !options?.forceRefresh && Date.now() < cached.prefetchedAt + cached.ttl) {
    return cached;
  }

  const scene = options?.scene || 'unknown';
  const now = Date.now();

  try {
    const [schedule, weather, recentConversation, sceneMemories] = await Promise.all([
      fetchSchedule(uid),
      fetchWeather(uid),
      fetchRecentConversation(uid),
      fetchSceneMemories(uid, scene),
    ]);

    const data: PrefetchedData = {
      schedule,
      weather,
      recentConversation,
      sceneMemories,
      prefetchedAt: now,
      ttl: DEFAULT_TTL,
    };

    store.set(uid, data);
    logger.info(`[Prefetch] ✅ uid=${uid} scene=${scene} schedule=${!!schedule} weather=${!!weather} conv=${!!recentConversation} memories=${sceneMemories.length}`);
    return data;
  } catch (e: any) {
    logger.warn('[Prefetch] 预取失败:', e.message);
    return null;
  }
}

/** 获取已预取的内容 */
export function getPrefetchedContext(uid: string): PrefetchedContext | null {
  const data = store.get(uid);
  if (!data || Date.now() > data.prefetchedAt + data.ttl) {
    return null;
  }

  const parts: string[] = [];

  if (data.schedule) {
    parts.push(`## 预判：今日日程\n${data.schedule}`);
  }
  if (data.weather) {
    parts.push(`## 预判：天气\n${data.weather}`);
  }
  if (data.recentConversation) {
    parts.push(`## 预判：最近对话\n${data.recentConversation}`);
  }
  if (data.sceneMemories.length > 0) {
    parts.push(`## 预判：场景相关记忆\n${data.sceneMemories.map((m, i) => `${i + 1}. ${m}`).join('\n')}`);
  }

  if (parts.length === 0) return null;

  return {
    summary: parts.join('\n\n'),
    source: `prefetch_${data.prefetchedAt}`,
  };
}

/** 使用后清理缓存 */
export function clearPrefetchedContext(uid: string): void {
  store.delete(uid);
  logger.debug(`[Prefetch] 缓存已清理 uid=${uid}`);
}

/** 检查是否需要刷新预判 */
export function shouldPrefetch(uid: string, _scene?: string): boolean {
  const cached = store.get(uid);
  if (!cached) return true;
  return Date.now() > cached.prefetchedAt + cached.ttl;
}

/** 判断是否应触发预判（供 TICK 调用） */
export function shouldTriggerPrefetch(uid: string): boolean {
  return isIdleWindow() || isMorningWindow() || shouldPrefetch(uid);
}

// ── 数据获取函数 ──

/** 获取今日日程（从 memory 检索日程相关记忆） */
async function fetchSchedule(uid: string): Promise<string | null> {
  try {
    const memories = await queryMemories({
      userId: uid,
      query: `今日日程 ${todayStr()} 安排 计划`,
      limit: 5,
      useVector: false,
    });
    if (memories.length === 0) return null;
    const items = memories
      .filter(m => m.content.includes(todayStr()) || m.content.includes('日程') || m.content.includes('计划'))
      .map(m => m.content.slice(0, 120));
    return items.length > 0 ? items.join(' | ') : null;
  } catch {
    return null;
  }
}

/** 获取天气信息（从记忆检索最近天气相关记忆） */
async function fetchWeather(uid: string): Promise<string | null> {
  try {
    const memories = await queryMemories({
      userId: uid,
      query: `天气 ${todayStr()} 晴 雨 温度`,
      limit: 3,
      useVector: false,
    });
    if (memories.length === 0) return null;
    const weatherMem = memories.find(m =>
      m.content.includes('天气') || m.content.includes('温度') || m.content.includes('°')
    );
    return weatherMem ? weatherMem.content.slice(0, 200) : null;
  } catch {
    return null;
  }
}

/** 获取最近一次对话摘要 */
async function fetchRecentConversation(uid: string): Promise<string | null> {
  try {
    const memories = await queryMemories({
      userId: uid,
      query: '最近对话 聊天 讨论',
      limit: 5,
      useVector: false,
    });
    if (memories.length === 0) return null;
    const recent = memories[0];
    const topics = extractTopics(recent.content);
    const topicStr = topics.length > 0 ? ` [话题: ${topics.join(', ')}]` : '';
    return `${recent.content.slice(0, 150)}${topicStr}`;
  } catch {
    return null;
  }
}

/** 获取场景相关记忆 */
async function fetchSceneMemories(uid: string, scene: string): Promise<string[]> {
  const sceneLabel = SCENE_LABELS[scene] || '通用';
  try {
    const memories = await queryMemories({
      userId: uid,
      query: `${sceneLabel} 场景 相关 记忆`,
      limit: 5,
      useVector: false,
    });
    return memories.map(m => m.content.slice(0, 150));
  } catch {
    return [];
  }
}
