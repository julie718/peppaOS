/**
 * Autonomous Task Generator — curiosity-driven self-initiation.
 * Gathers context about the user's state and asks the LLM to suggest useful autonomous tasks.
 */
import { isAutonomousWorkAllowed } from './safety_gate';
import { enqueue } from './task_queue';
import { readDB } from '../../db_layer';
import { makeLLMCall, NormalizedMessage } from '../llm/providers';
import { getRecentActivity } from '../context/activity_stream';

interface LLMGetters {
  getDeepSeek: () => any;
  getGemini: () => any;
  getOpenAI?: () => any;
  getAnthropic?: () => any;
  getQwen?: () => any;
}

export async function generateAutonomousTasks(
  userId: string,
  getters: LLMGetters,
): Promise<number> {
  // Safety gate check
  const gate = isAutonomousWorkAllowed(userId);
  if (!gate.allowed) {
    console.log(`[AutoTasks] Gate blocked: ${gate.reason}`);
    return 0;
  }

  // Build context
  const contextParts: string[] = [];
  const now = new Date();
  const hour = now.getHours();
  const day = now.getDay();
  const isWeekday = day >= 1 && day <= 5;
  contextParts.push(`当前时间: ${now.toLocaleString('zh-CN')} (${isWeekday ? '工作日' : '周末'})`);

  // Recent activity
  const recentActivity = getRecentActivity(userId, 15);
  const windowChanges = recentActivity.filter(e => e.type === 'window_changed');
  if (windowChanges.length > 0) {
    const appNames = [...new Set(windowChanges.map(e => e.data?.process_name).filter(Boolean))];
    contextParts.push(`最近活跃应用: ${appNames.join(', ')}`);

    // Detect specific app launches for contextual triggers
    const latestWindow = windowChanges[windowChanges.length - 1]?.data;
    if (latestWindow?.process_name) {
      const app = latestWindow.process_name.toLowerCase();
      if (app.includes('code') || app.includes('vscode')) contextParts.push('用户刚切换到了代码编辑器');
      if (app.includes('excel') || app.includes('wps')) contextParts.push('用户正在处理电子表格');
      if (app.includes('wechat')) contextParts.push('用户正在使用微信');
      if (app.includes('cad') || app.includes('autocad')) contextParts.push('用户正在使用CAD软件');
      if (app.includes('chrome') || app.includes('edge') || app.includes('firefox')) contextParts.push('用户正在浏览网页');
    }
  }

  // Clipboard context
  const clipboardEvents = recentActivity.filter(e => e.type === 'clipboard_changed');
  if (clipboardEvents.length > 0) {
    const clipText = clipboardEvents[clipboardEvents.length - 1]?.data?.text || '';
    if (clipText && clipText.length > 10 && clipText.length < 500) {
      contextParts.push(`剪贴板最新内容: "${clipText.slice(0, 200)}"`);
      if (clipText.includes('http://') || clipText.includes('https://')) contextParts.push('剪贴板包含URL链接');
      if (/```|function|class|def |import /.test(clipText)) contextParts.push('剪贴板包含代码片段');
      if (/TODO|FIXME|HACK|WIP/.test(clipText)) contextParts.push('剪贴板包含待办标记');
    }
  }

  // Time-of-day context
  if (isWeekday && hour >= 8 && hour <= 10) contextParts.push('工作日上午，用户可能在规划一天');
  if (isWeekday && hour >= 11 && hour <= 13) contextParts.push('临近午休时间');
  if (isWeekday && hour >= 16 && hour <= 18) contextParts.push('下午收尾阶段');
  if (hour >= 21 && hour <= 23) contextParts.push('晚间时段，用户可能在放松或学习');

  // Recent memories
  const db = readDB();
  const recentMemories = (db.memories || [])
    .filter((m: any) => m.userId === userId && m.confidence >= 0.4)
    .slice(-10)
    .map((m: any) => m.content.slice(0, 100));
  if (recentMemories.length > 0) {
    contextParts.push(`近期相关记忆: ${recentMemories.join('; ')}`);
  }

  // Pending reminders
  const pendingReminders = (db.memories || [])
    .filter((m: any) => m.userId === userId && m.type === 'reminder' && m.confidence > 0)
    .slice(0, 5)
    .map((m: any) => m.content);
  if (pendingReminders.length > 0) {
    contextParts.push(`待办事项: ${pendingReminders.join('; ')}`);
  }

  if (contextParts.length === 0) return 0;

  const prompt = `你是 Lumi 的后台自主任务规划器。根据用户当前的上下文，建议 1-3 个你可以自主完成的小任务。

要求：
- 安全无害（不删除文件、不执行危险命令）
- 快速完成（2分钟内，不要需要多轮交互）
- 真正有用（根据上下文判断）
- 自包含（不需要追问用户）

上下文:
${contextParts.join('\n')}

返回 JSON 数组（不要 markdown，不要解释）:
[
  {
    "title": "任务简短标题",
    "description": "详细执行描述，作为LLM执行提示词",
    "mode": "desktop" | "terminal" | "analysis",
    "priority": 1-10
  }
]

如果当前没有合适的自主任务，返回空数组 []。`;

  try {
    const messages: NormalizedMessage[] = [{ role: 'user', content: prompt }];
    const result = await makeLLMCall(
      messages, [],
      { provider: 'qwen', model: 'qwen-turbo', maxTokens: 500 },
      getters.getDeepSeek, getters.getGemini,
      getters.getOpenAI || (() => null),
      getters.getAnthropic || (() => null),
      getters.getQwen || (() => null),
    );

    const text = (result.text || '').replace(/```json|```/g, '').trim();
    if (!text || text === '[]') return 0;

    let tasks: { title: string; description: string; mode: 'desktop' | 'terminal' | 'analysis'; priority: number }[];
    try {
      tasks = JSON.parse(text);
    } catch {
      console.log('[AutoTasks] Failed to parse LLM response:', text.slice(0, 200));
      return 0;
    }

    if (!Array.isArray(tasks) || tasks.length === 0) return 0;

    let enqueued = 0;
    for (const t of tasks) {
      if (!t.title || !t.description) continue;
      const task = enqueue({
        userId,
        title: t.title.slice(0, 120),
        description: t.description.slice(0, 500),
        source: 'curiosity',
        priority: Math.max(1, Math.min(10, t.priority || 5)),
        mode: t.mode === 'desktop' || t.mode === 'terminal' ? t.mode : 'analysis',
      });
      if (task) enqueued++;
    }

    console.log(`[AutoTasks] Generated ${enqueued} autonomous tasks for ${userId}`);
    return enqueued;
  } catch (err: any) {
    console.warn(`[AutoTasks] Generation failed:`, err.message);
    return 0;
  }
}
