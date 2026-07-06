// Relationship milestone tracker — tracks user↔Peppa relationship timeline

import { readDB } from '../../db_layer';
import { getUserNow, daysSince } from './utils';
import { queryMemories } from '../memory/store';

export interface Milestone {
  type: 'first_interaction' | 'day_count' | 'longest_conversation' | 'memory_milestone' | 'interaction_milestone';
  title: string;
  description: string;
  date: string;
  value: number;
}

export interface RelationshipDuration {
  days: number;
  firstInteraction: string;
  firstInteractionDate: string;
}

export function getRelationshipDuration(userId: string): RelationshipDuration | null {
  const db = readDB();
  const interactions = (db.interactions || [])
    .filter((i: any) => i.userId === userId)
    .sort((a: any, b: any) => a.timestamp.localeCompare(b.timestamp));

  if (interactions.length === 0) return null;

  const first = interactions[0].timestamp;
  const days = Math.floor(daysSince(first));

  return {
    days,
    firstInteraction: first,
    firstInteractionDate: new Date(first).toISOString().slice(0, 10),
  };
}

export interface NotableMoment {
  date: string;
  title: string;
  description: string;
  value: number;
}

export function getNotableMoments(userId: string, limit: number = 5): NotableMoment[] {
  const db = readDB();
  const moments: NotableMoment[] = [];

  // Longest conversation (by message count)
  const conversations = (db.conversations || [])
    .filter((c: any) => c.userId === userId);

  if (conversations.length > 0) {
    const longest = conversations.reduce((best: any, c: any) =>
      (c.messageCount || 0) > (best.messageCount || 0) ? c : best,
      conversations[0],
    );
    if (longest && (longest.messageCount || 0) > 5) {
      moments.push({
        date: longest.createdAt || longest.lastActiveAt,
        title: '最长对话',
        description: `你和Peppa的对话最长一次有 ${longest.messageCount} 条消息`,
        value: longest.messageCount || 0,
      });
    }
  }

  // Most memories in a single day
  const memories = (db.memories || []).filter((m: any) => m.userId === userId);
  if (memories.length > 0) {
    const byDay = new Map<string, number>();
    for (const m of memories) {
      const day = (m.createdAt || '').slice(0, 10);
      if (day) byDay.set(day, (byDay.get(day) || 0) + 1);
    }
    const peakDay = [...byDay.entries()].sort((a, b) => b[1] - a[1])[0];
    if (peakDay && peakDay[1] > 3) {
      moments.push({
        date: peakDay[0],
        title: '记忆爆发日',
        description: `${peakDay[0]} 这一天形成了 ${peakDay[1]} 条记忆`,
        value: peakDay[1],
      });
    }
  }

  // Most tool calls in a single interaction
  const interactions = (db.interactions || []).filter((i: any) => i.userId === userId);
  if (interactions.length > 0) {
    const mostTools = interactions.reduce((best: any, i: any) => {
      const tc = Array.isArray(i.toolCalls) ? i.toolCalls.length : 0;
      return tc > (best.toolCalls?.length || 0) ? i : best;
    }, interactions[0]);
    const tcCount = Array.isArray(mostTools.toolCalls) ? mostTools.toolCalls.length : 0;
    if (tcCount > 3) {
      moments.push({
        date: mostTools.timestamp,
        title: '最大工具调用',
        description: `一次对话中调用了 ${tcCount} 个工具`,
        value: tcCount,
      });
    }
  }

  // Sort by date descending, take top N
  moments.sort((a, b) => b.date.localeCompare(a.date));
  return moments.slice(0, limit);
}

export function checkMilestone(userId: string): Milestone | null {
  const rel = getRelationshipDuration(userId);
  if (!rel) return null;

  const milestones = [1, 7, 30, 50, 100, 150, 200, 300, 365, 500, 730, 1000];

  for (const m of milestones) {
    if (rel.days === m) {
      const titles: Record<number, string> = {
        1: '初次相遇',
        7: '一周纪念',
        30: '一个月纪念',
        50: '50天纪念',
        100: '百日纪念',
        150: '150天纪念',
        200: '200天纪念',
        300: '300天纪念',
        365: '一周年纪念',
        500: '500天纪念',
        730: '两周年纪念',
        1000: '1000天纪念',
      };

      return {
        type: 'day_count',
        title: titles[m] || `${m}天纪念`,
        description: `今天是你和Peppa认识的第 ${m} 天！从${rel.firstInteractionDate}开始，我们已经一起走过了 ${m} 天。`,
        date: new Date().toISOString(),
        value: m,
      };
    }
  }

  // Check memory milestones (every 100 memories)
  const db = readDB();
  const memoryCount = (db.memories || []).filter((m: any) => m.userId === userId).length;
  if (memoryCount > 0 && memoryCount % 100 === 0) {
    return {
      type: 'memory_milestone',
      title: '记忆里程碑',
      description: `Peppa已经为你积累了 ${memoryCount} 条记忆！这是我们共同的宝贵财富。`,
      date: new Date().toISOString(),
      value: memoryCount,
    };
  }

  // Check interaction milestones (every 500 interactions)
  const interactionCount = (db.interactions || []).filter((i: any) => i.userId === userId).length;
  if (interactionCount > 0 && interactionCount % 500 === 0) {
    return {
      type: 'interaction_milestone',
      title: '对话里程碑',
      description: `我们已经完成了 ${interactionCount} 次对话！每一次都让Peppa更懂你。`,
      date: new Date().toISOString(),
      value: interactionCount,
    };
  }

  return null;
}

/** Get memories from "this day in history" for the given user */
export function getThisDayMemories(userId: string): { content: string; year: number; month: number; day: number }[] {
  const now = getUserNow(userId);
  const month = now.getMonth() + 1;
  const day = now.getDate();
  const currentYear = now.getFullYear();

  const results: { content: string; year: number; month: number; day: number }[] = [];

  for (let yearOffset = 1; yearOffset <= 3; yearOffset++) {
    const year = currentYear - yearOffset;
    const mStr = String(month).padStart(2, '0');
    const dStr = String(day).padStart(2, '0');
    const after = `${year}-${mStr}-${dStr}T00:00:00.000Z`;
    const nextDay = day + 1;
    const before = `${year}-${mStr}-${String(nextDay).padStart(2, '0')}T00:00:00.000Z`;

    const matches = queryMemories({ userId, after, before, limit: 10 });
    for (const m of matches) {
      results.push({
        content: m.content.slice(0, 150),
        year,
        month,
        day,
      });
    }
  }

  return results;
}
