// 逆地理编码 + 本地缓存 — 坐标→地址
const cache = new Map<string, { address: string; updatedAt: number }>();
const CACHE_TTL = 3600000; // 1 小时

export async function reverseGeocode(lat: number, lng: number): Promise<string> {
  const key = `${lat.toFixed(4)},${lng.toFixed(4)}`;

  // 1. 本地内存缓存
  const cached = cache.get(key);
  if (cached && Date.now() - cached.updatedAt < CACHE_TTL) {
    return cached.address;
  }

  // 2. Nominatim（免费，无 API key）
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json&zoom=16&accept-language=zh`;
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'PeppaOS/1.0' },
      signal: AbortSignal.timeout(5000),
    });
    if (resp.ok) {
      const data = await resp.json() as any;
      const address = data?.display_name || '';
      if (address) {
        const short = shortenAddress(address, lat, lng);
        cache.set(key, { address: short, updatedAt: Date.now() });
        return short;
      }
    }
  } catch {}

  // 3. 回退：坐标文本
  const fallback = `纬度${lat.toFixed(4)}, 经度${lng.toFixed(4)}`;
  cache.set(key, { address: fallback, updatedAt: Date.now() });
  return fallback;
}

function shortenAddress(full: string, lat: number, lng: number): string {
  // Nominatim 返回完整层级：建筑, 道路, 区, 市, 省, 国家
  // 截取前 80 字，保留最重要的两级
  const parts = full.split(',').map(s => s.trim());
  if (parts.length >= 2) {
    return parts.slice(0, Math.min(4, parts.length - 1)).join(', ');
  }
  return full.slice(0, 80) || `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
}
