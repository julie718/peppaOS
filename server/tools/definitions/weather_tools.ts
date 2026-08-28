// 天气查询工具 — Open-Meteo 免费 API（无需 Key）
import { ToolRegistry } from '../registry';
import { logger } from '../../../logger';
import { classifyBuiltinToolRisk } from '../../skills_extension/risk_policy';
import { ToolContext } from '../types';
import { readDB } from '../../../db_layer';

/**
 * 参数智能处理（任务清单第 5 项）：
 *   ① 用户输入包含城市 → 优先使用用户提供城市（LLM 填入 args.city）；
 *   ② 用户未写城市 → 读取会话内用户定位（location_${userId}，iPhone GPS 写入），查询所在地天气；
 *   ③ 既无城市也无定位 → 反问用户需要查询哪个城市（返回引导文本，不抛工具错误）。
 */
function resolveUserLocation(userId?: string): { city?: string; lat?: number; lng?: number } | null {
  if (!userId) return null;
  try {
    const db = readDB();
    const setting = (db.settings || []).find((s: any) => s.key === `location_${userId}`);
    if (!setting) return null;
    const loc = JSON.parse(setting.value);
    const lat = Number(loc?.lat);
    const lng = Number(loc?.lng);
    if (!lat || !lng) return null;
    // 定位地址文本命中已知城市名 → 用城市名；否则坐标直查 Open-Meteo
    // （address 为空时跳过城市匹配，避免空串命中全部键误回退北京）
    const address = String(loc?.address || '');
    const cityKey = address ? Object.keys(cityCoords).find(k => address.includes(k) || k.includes(address)) : undefined;
    return { city: cityKey, lat, lng };
  } catch { return null; }
}

/** 缺城市且无定位时的反问引导（非错误：LLM 收到后向用户询问城市） */
const ASK_CITY_HINT =
  '用户未提供城市，且当前没有该用户的定位信息。请向用户询问需要查询哪个城市的天气，不要臆测城市，也不要重复调用本工具。';

// 城市名→坐标映射
// 阶段一·模块1: 导出供 travel-cal-mcp 复用（统一底层，杜绝重复编码）
export const cityCoords: Record<string, [number, number]> = {
  '北京': [39.9, 116.4], '上海': [31.2, 121.5], '广州': [23.1, 113.3],
  '深圳': [22.5, 114.1], '杭州': [30.3, 120.2], '南京': [32.1, 118.8],
  '成都': [30.6, 104.1], '武汉': [30.6, 114.3], '重庆': [29.6, 106.5],
  '沈阳': [41.8, 123.4], '西安': [34.3, 108.9], '天津': [39.1, 117.2],
  '青岛': [36.1, 120.4], '大连': [38.9, 121.6], '厦门': [24.5, 118.1],
  '长沙': [28.2, 113.0], '郑州': [34.8, 113.6], '济南': [36.7, 117.0],
  '哈尔滨': [45.8, 126.5], '昆明': [25.0, 102.7], '抚顺': [41.9, 123.9],
  '苏州': [31.3, 120.6], '合肥': [31.8, 117.2], '福州': [26.1, 119.3],
  '南昌': [28.7, 115.9], '南宁': [22.8, 108.3], '贵阳': [26.6, 106.7],
  '兰州': [36.1, 103.8], '银川': [38.5, 106.1], '西宁': [36.6, 101.8],
  '拉萨': [29.6, 91.1], '乌鲁木齐': [43.8, 87.6], '呼和浩特': [40.8, 111.8],
  '三亚': [18.2, 109.5], '珠海': [22.3, 113.6], '宁波': [29.9, 121.6],
  'beijing': [39.9, 116.4], 'shanghai': [31.2, 121.5], 'tokyo': [35.7, 139.7],
  'london': [51.5, -0.1], 'new york': [40.7, -74.0], 'paris': [48.9, 2.3],
  'berlin': [52.5, 13.4], 'sydney': [-33.9, 151.2], 'seoul': [37.6, 127.0],
  'singapore': [1.3, 103.8], 'bangkok': [13.8, 100.5], 'mumbai': [19.1, 72.9],
  'dubai': [25.2, 55.3], 'moscow': [55.8, 37.6],
};

const weatherCodes: Record<number, string> = {
  0: '晴', 1: '晴间多云', 2: '多云', 3: '阴',
  45: '雾', 48: '霜雾', 51: '小雨', 53: '中雨', 55: '大雨',
  56: '冻雨', 57: '冻雨', 61: '小雨', 63: '中雨', 65: '大雨',
  66: '冻雨', 67: '冻雨', 71: '小雪', 73: '中雪', 75: '大雪',
  77: '雪粒', 80: '阵雨', 81: '中阵雨', 82: '大阵雨',
  85: '小阵雪', 86: '大阵雪', 95: '雷暴', 96: '冰雹雷暴', 99: '大冰雹雷暴',
};

export function resolveCoords(city: string): [number, number] {
  // 精确匹配
  if (cityCoords[city]) return cityCoords[city];
  // 模糊匹配：输入包含已知城市名，或已知城市名包含输入
  const key = Object.keys(cityCoords).find(k => city.includes(k) || k.includes(city));
  return key ? cityCoords[key] : [39.9, 116.4]; // fallback 北京
}

// 阶段一·模块1: 导出供 travel-cal-mcp 复用（统一底层，杜绝重复编码）
export async function fetchWeather(lat: number, lng: number): Promise<any> {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}`
    + `&current=temperature_2m,relative_humidity_2m,wind_speed_10m,weather_code`
    + `&daily=temperature_2m_max,temperature_2m_min,weather_code,precipitation_probability_max`
    + `&timezone=auto&forecast_days=5`;
  const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
  return resp.json();
}

/** 阶段一·模块1: 城市天气直查（travel-cal-mcp 复用入口） */
export async function fetchWeatherByCity(city: string): Promise<any> {
  const [lat, lng] = resolveCoords(city);
  const data = await fetchWeather(lat, lng);
  return { city, lat, lng, data };
}

/**
 * 城市解析（任务清单第 5 项）：
 *   ① args.city（用户提供城市）→ 优先；
 *   ② 无 city → 会话内用户定位（address 命中城市名 / 坐标直查）；
 *   ③ 均无 → 返回反问引导（不报错）。
 * 返回值：查询坐标；或 { askCity: true } 表示需向用户反问。
 */
export function resolveQueryTarget(args: Record<string, any>, context?: ToolContext): { lat: number; lng: number; city: string } | { askCity: true } {
  const city = String(args.city || '').trim();
  if (city) {
    const [lat, lng] = resolveCoords(city);
    return { lat, lng, city };
  }
  const loc = resolveUserLocation(context?.userId);
  if (loc) {
    if (loc.city) {
      const [lat, lng] = resolveCoords(loc.city);
      return { lat, lng, city: loc.city };
    }
    return { lat: loc.lat!, lng: loc.lng!, city: '当前位置' };
  }
  return { askCity: true };
}

async function weatherCurrent(args: Record<string, any>, context?: ToolContext): Promise<string> {
  const target = resolveQueryTarget(args, context);
  if ('askCity' in target) return ASK_CITY_HINT;
  const { city, lat, lng } = target;

  try {
    const data = await fetchWeather(lat, lng);
    const current = data.current || {};
    const temp = current.temperature_2m ?? 0;
    const code = current.weather_code ?? 0;
    const condition = weatherCodes[code] || '未知';
    const humidity = current.relative_humidity_2m ?? 0;
    const wind = current.wind_speed_10m ?? 0;

    logger.info(`[Weather] ${city} → ${temp}°C ${condition}`);

    // 【重构·模块4】固定话术模板移除：返回结构化数据，由心智内核组织表述
    return JSON.stringify({ city, temp, condition, code, humidity, wind, tempUnit: '°C', windUnit: 'km/h' });
  } catch (e: any) {
    logger.error('[Weather] 查询失败:', e.message);
    return `天气查询失败: ${e.message}`;
  }
}

async function weatherForecast(args: Record<string, any>, context?: ToolContext): Promise<string> {
  const days = Math.min(Math.max(Number(args.days) || 3, 1), 5);
  const target = resolveQueryTarget(args, context);
  if ('askCity' in target) return ASK_CITY_HINT;
  const { city, lat, lng } = target;

  try {
    const data = await fetchWeather(lat, lng);
    const daily = data.daily || {};
    const items: { date: string; high: number; low: number; condition: string; precip?: number }[] = [];

    for (let i = 0; i < Math.min(days, (daily.time || []).length); i++) {
      const code = daily.weather_code?.[i];
      items.push({
        date: daily.time[i],
        high: daily.temperature_2m_max?.[i] ?? 0,
        low: daily.temperature_2m_min?.[i] ?? 0,
        condition: weatherCodes[code] || '未知',
        precip: daily.precipitation_probability_max?.[i] ?? undefined,
      });
    }

    logger.info(`[Weather] forecast ${city} × ${days} days`);
    return JSON.stringify({ city, days, items, tempUnit: '°C' });
  } catch (e: any) {
    logger.error('[Weather] 预报失败:', e.message);
    return `天气预报查询失败: ${e.message}`;
  }
}

export function registerWeatherTools(registry: ToolRegistry): void {
  registry.register({
    name: 'weather_current',
    description:
      '查询城市当前天气，返回温度、天气状况、湿度、风速。支持200+中国城市。使用 Open-Meteo 免费 API，无需 API Key。'
      + '参数规则：用户明确提到城市时必须填写用户提到的城市；用户未提供城市时省略 city 参数（系统会自动使用用户定位，或引导向用户询问）。',
    parameters: {
      type: 'object',
      properties: {
        city: { type: 'string', description: '城市名称，如"北京"、"上海"、"杭州"。支持中英文。仅当用户明确提到城市时填写；未提供城市时省略本参数。' },
      },
      required: [],
    },
    handler: weatherCurrent,
    permission: 'user',
    securityLevel: classifyBuiltinToolRisk('查询城市当前天气，返回温度、天气状况、湿度、风速。支持200+中国城市。使用 Open-Meteo 免费 API，无需 API Key。'),
  });

  registry.register({
    name: 'weather_forecast',
    description:
      '查询城市未来几天天气预报，返回每日天气状况、最高/最低温度、降水概率。最多支持5天预报。'
      + '参数规则：用户明确提到城市时必须填写用户提到的城市；用户未提供城市时省略 city 参数（系统会自动使用用户定位，或引导向用户询问）。',
    parameters: {
      type: 'object',
      properties: {
        city: { type: 'string', description: '城市名称，如"北京"、"上海"。仅当用户明确提到城市时填写；未提供城市时省略本参数。' },
        days: { type: 'number', description: '预报天数（1-5，默认3）' },
      },
      required: [],
    },
    handler: weatherForecast,
    permission: 'user',
    securityLevel: classifyBuiltinToolRisk('查询城市未来几天天气预报，返回每日天气状况、最高/最低温度、降水概率。最多支持5天预报。'),
  });
}
