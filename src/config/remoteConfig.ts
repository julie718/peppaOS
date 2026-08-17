/**
 * 远程应用配置：启动时从服务器 /config.json 获取 apiBase。
 *
 * iOS 原生侧（ios/App/App/RemoteConfig.swift）在 WebView 加载前已用 apiBase
 * 解析出起始 URL，页面加载后相对路径 /api 请求会自动跟随页面 origin 指向 apiBase。
 * 本模块做二次校验：当页面 origin 与配置的 apiBase 不一致时（例如服务器迁移后
 * 旧域名仍在对外提供页面），整页重定向到正确地址；配置拉取失败则维持现状。
 */

export interface RemoteAppConfig {
  apiBase: string;
  version?: string;
}

/** 兜底默认 apiBase —— 配置拉取失败时使用 */
export const DEFAULT_API_BASE = 'https://peppaos.qweasd.top';

const CONFIG_TIMEOUT_MS = 5000;

/** 从当前 origin 拉取 /config.json（同源请求，无跨域问题） */
export async function fetchRemoteConfig(): Promise<RemoteAppConfig | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CONFIG_TIMEOUT_MS);
    const res = await fetch('/config.json', { signal: controller.signal, cache: 'no-store' });
    clearTimeout(timer);
    if (!res.ok) return null;
    const json = (await res.json()) as Partial<RemoteAppConfig>;
    if (typeof json.apiBase !== 'string' || !json.apiBase.trim()) return null;
    return { apiBase: json.apiBase.trim().replace(/\/+$/, ''), version: json.version };
  } catch {
    return null;
  }
}

/**
 * 校验当前 origin 是否为配置的 apiBase；不一致则整页重定向到
 * <apiBase>/index.mobile.html。返回 true 表示已发起跳转（调用方应停止后续逻辑）。
 */
export async function ensureConfiguredOrigin(): Promise<boolean> {
  const config = await fetchRemoteConfig();
  if (!config) return false;
  let target: URL;
  try {
    target = new URL(`${config.apiBase}/index.mobile.html`);
  } catch {
    return false; // 配置损坏则不跳转，避免重定向死循环
  }
  if (target.origin === window.location.origin) return false;
  if (target.protocol !== 'http:' && target.protocol !== 'https:') return false;
  window.location.replace(target.href);
  return true;
}
