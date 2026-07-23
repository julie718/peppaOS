// PeppaOS 本地通知服务 — 横幅推送 + 角标管理
import { LocalNotifications } from '@capacitor/local-notifications';

let badgeCount = 0;

export async function requestPermission(): Promise<boolean> {
  try {
    const result = await LocalNotifications.requestPermissions();
    return result.display === 'granted';
  } catch {
    return false;
  }
}

export async function sendNotification(
  title: string,
  body: string,
  data?: Record<string, any>,
): Promise<void> {
  try {
    badgeCount++;
    await LocalNotifications.schedule({
      notifications: [{
        id: Date.now(),
        title,
        body: body.slice(0, 200),
        extra: data || {},
        schedule: { at: new Date(Date.now() + 100) },
      }],
    });
    await updateBadge(badgeCount);
  } catch (e) {
    console.warn('[Notification] 发送失败:', e);
  }
}

export async function updateBadge(count: number): Promise<void> {
  badgeCount = Math.max(0, count);
}

export async function clearBadge(): Promise<void> {
  badgeCount = 0;
  try {
    await LocalNotifications.cancel({ notifications: [{ id: -1 }] });
  } catch {}
}

export function getBadgeCount(): number {
  return badgeCount;
}

export async function fetchNotifications(): Promise<{ notifications: any[] }> {
  // 服务端通知暂未实现，返回空
  return { notifications: [] };
}
