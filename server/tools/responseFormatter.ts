// 自然语言包装器 — 将工具返回的结构化数据转为"像人说话"的自然表达
// 不调用 LLM，纯文本模板组合，0 Token 消耗

// ── 工具函数 ──

function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function maybe(probability: number, text: string): string {
  return Math.random() < probability ? text : '';
}

// ── 天气描述映射 ──

const TEMP_MOOD: { max: number; label: string; comment: string }[] = [
  { max: -10, label: '严寒', comment: '冷得刺骨，裹紧羽绒服！' },
  { max: 0, label: '很冷', comment: '挺冷的，穿暖和点。' },
  { max: 10, label: '偏冷', comment: '有点凉，带件外套吧。' },
  { max: 20, label: '微凉', comment: '温度刚好，很舒服。' },
  { max: 28, label: '温暖', comment: '天气不错，适合出门走走。' },
  { max: 35, label: '热', comment: '挺热的，注意防晒补水。' },
  { max: 99, label: '酷热', comment: '热得很！尽量待在凉快的地方。' },
];

function tempMood(temp: number): string {
  return TEMP_MOOD.find(t => temp <= t.max)?.comment ?? TEMP_MOOD[TEMP_MOOD.length - 1].comment;
}

const RAIN_CODES = new Set([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82, 95, 96, 99]);
const RAIN_TIPS = ['出门记得带伞 ☔', '外面下雨，带把伞吧。', '雨天路滑，小心出行。', '记得带伞哦～'];

const SUN_CODES = new Set([0, 1]);
const SUN_TIPS = ['阳光正好 ☀️', '适合出门的好天气。', '天气不错，晒晒太阳吧。'];

function weatherTip(code: number): string {
  if (RAIN_CODES.has(code)) return pick(RAIN_TIPS);
  if (SUN_CODES.has(code)) return pick(SUN_TIPS);
  return '';
}

function windDesc(speed: number): string {
  if (speed < 5) return '风很小';
  if (speed < 20) return '有点微风';
  if (speed < 40) return '风不小';
  return '风很大';
}

// ── 天气格式化 ──

export function formatWeatherCurrent(args: {
  city: string;
  temp: number;
  condition: string;
  code: number;
  humidity: number;
  wind: number;
}): string {
  const { city, temp, condition, code, humidity, wind } = args;
  const mood = tempMood(temp);
  const tip = weatherTip(code);
  const windStr = windDesc(wind);

  const templates = [
    // 模板1: 感受优先
    () => {
      const parts = [`${city}现在${temp}°C，${condition}。`];
      parts.push(`${mood}`);
      if (tip) parts.push(tip);
      parts.push(`湿度${humidity}%，${windStr}。`);
      return parts.join('');
    },
    // 模板2: 简洁直接
    () => {
      const emoji = RAIN_CODES.has(code) ? '🌧' : SUN_CODES.has(code) ? '☀️' : '⛅';
      return `${emoji} ${city}：${temp}°C，${condition}，湿度${humidity}%。${tip || mood}`;
    },
    // 模板3: 对话感
    () => {
      const greeting = pick(['看了下', '帮你查了', '嗯，', '好的，']);
      const feel = temp > 30 ? '还挺热的' : temp > 20 ? '体感舒服' : temp > 10 ? '稍微有点凉' : '挺冷的';
      return `${greeting}${city}这会儿${temp}度，${condition}，${feel}。${tip || ''}`;
    },
    // 模板4: 详细体贴
    () => {
      return [
        `📍 ${city}`,
        `🌡 ${temp}°C  ${condition}`,
        `💧 湿度 ${humidity}%  ${windStr}`,
        `${mood}${tip ? '  ' + tip : ''}`,
      ].join('\n');
    },
  ];

  return pick(templates)();
}

export function formatWeatherForecast(args: {
  city: string;
  days: number;
  items: { date: string; high: number; low: number; condition: string; precip?: number }[];
}): string {
  const { city, days, items } = args;

  // 判断趋势
  const highs = items.map(i => i.high);
  const trend = highs[highs.length - 1] > highs[0] + 3 ? '升温趋势' :
                highs[highs.length - 1] < highs[0] - 3 ? '降温趋势' : '温度平稳';
  const hasRain = items.some(i => i.condition.includes('雨'));
  const rainWarn = hasRain ? pick(['有雨天，记得备伞。', '其中有雨，出门注意。', '雨天记得带伞～']) : '';

  const detailLines = items.map(i => {
    const precipStr = i.precip != null ? ` 降水${i.precip}%` : '';
    return `  ${i.date}  ${i.condition}  ${i.low}~${i.high}°C${precipStr}`;
  }).join('\n');

  const templates = [
    // 模板1: 趋势分析
    () =>
      `${city}未来${days}天${trend}。${rainWarn ? ' ' + rainWarn : ''}\n${detailLines}`,
    // 模板2: 对话感
    () => {
      const opener = pick(['帮你看了一下', '预报来了', '查到了', '嗯，']);
      return `${opener}${city}接下来${days}天——\n${detailLines}\n整体${trend}。${rainWarn}`;
    },
    // 模板3: 简洁
    () => {
      const bestDay = items.reduce((a, b) =>
        (a.condition.includes('雨') ? 1 : 0) > (b.condition.includes('雨') ? 1 : 0) ? b : a
      );
      return [
        `📍 ${city} 未来${days}天`,
        detailLines,
        `${trend}。${bestDay && !bestDay.condition.includes('雨') ? ` ${pick(['天气最好的是', '推荐'])}${bestDay.date}，${bestDay.condition}。` : ''}${rainWarn ? ' ' + rainWarn : ''}`,
      ].join('\n');
    },
  ];

  return pick(templates)();
}

// ── 新闻格式化 ──

export function formatNewsHeadlines(args: {
  category: string;
  items: { title: string; source: string; url: string; published?: string }[];
}): string {
  const { category, items } = args;

  if (items.length === 0) {
    return pick([
      `暂时没找到${category}方面的最新新闻，要不换个类别试试？`,
      `${category}类新闻这会儿没刷出来，稍后再试？`,
      `关于${category}暂时没有新消息。`,
    ]);
  }

  const list = items.map((item, i) => {
    const pub = item.published ? ` · ${item.published}` : '';
    return `  ${i + 1}. ${item.title}\n     ${item.source}${pub}`;
  }).join('\n');

  const templates = [
    // 模板1: 推荐式
    () => {
      const opener = pick(['给你找了', '帮你搜了', '看到了', '整理了']);
      return `${opener}${category}方面的最新消息：\n\n${list}\n\n有感兴趣的可以点链接看详情。`;
    },
    // 模板2: 简洁
    () => {
      const highlight = items[0]?.title.slice(0, 30) + (items[0]?.title.length > 30 ? '…' : '');
      return `📰 最近${category}圈子的动态——比如"${highlight}"等${items.length}条：\n\n${list}`;
    },
    // 模板3: 对话感
    () => {
      const comment = pick([
        '有几条挺有意思的。',
        '信息量不小。',
        '大概就这些。',
        '你看看有没有感兴趣的。',
      ]);
      return `${category}新闻来了，扫了一眼${comment}\n\n${list}`;
    },
  ];

  return pick(templates)();
}

export function formatNewsSearch(args: {
  keyword: string;
  items: { title: string; source: string; url: string }[];
}): string {
  const { keyword, items } = args;

  if (items.length === 0) {
    return pick([
      `关于"${keyword}"没找到相关新闻，用 web_search 试试更广的搜索？`,
      `搜了一下"${keyword}"，没看到什么新闻。换个关键词？`,
      `"${keyword}"暂时没有匹配的新闻。`,
    ]);
  }

  const list = items.map((item, i) =>
    `  ${i + 1}. ${item.title}\n     ${item.source}`
  ).join('\n');

  const templates = [
    () => `搜了一下"${keyword}"，找到${items.length}条相关新闻：\n\n${list}`,
    () => {
      const verb = pick(['帮你查了', '搜了关于', '找了找']);
      return `${verb}"${keyword}"的消息——\n\n${list}\n\n${pick(['就这些。', '大概这些。', '你看看。'])}`;
    },
    () => `📰 关于"${keyword}"的${items.length}条新闻：\n\n${list}`,
  ];

  return pick(templates)();
}

// ── 日历格式化 ──

export function formatCalendarToday(args: {
  events: { time: string; title: string; location?: string; desc?: string; calendar?: string }[];
}): string {
  const { events } = args;
  const n = events.length;

  if (n === 0) {
    return pick([
      '今天日程是空的，没有安排～ ☕',
      '今天没什么事，自由安排吧。',
      '看了下日历，今天挺清闲的，没有日程。',
      '今天没有安排，可以放松一下。',
    ]);
  }

  const list = events.map(e => {
    const loc = e.location ? ` @${e.location}` : '';
    const desc = e.desc ? ` — ${e.desc.slice(0, 40)}${e.desc.length > 40 ? '…' : ''}` : '';
    return `  • ${e.time}  ${e.title}${loc}${desc}`;
  }).join('\n');

  const busyComment = n >= 6 ? pick(['今天排得挺满的 😅', '事情不少，加油！', '满满的一天。']) :
                      n >= 3 ? pick(['还算充实。', '刚刚好。', '有节奏的一天。']) :
                      pick(['比较轻松。', '压力不大。', '不算忙。']);

  const templates = [
    () => `📅 今天有${n}件事——\n${list}\n\n${busyComment}`,
    () => {
      const opener = pick(['看了下今天的日程', '嗯，今天安排了', '你今天的日程是']);
      return `${opener}${n}项：\n${list}\n\n${busyComment}`;
    },
    () => {
      const nextEvent = events[0];
      const nextStr = nextEvent ? ` 最近一个是"${nextEvent.title}"（${nextEvent.time}）` : '';
      return `今天共${n}个日程。${nextStr}\n\n${list}`;
    },
  ];

  return pick(templates)();
}

export function formatCalendarUpcoming(args: {
  days: number;
  events: { date: string; time: string; title: string; location?: string; desc?: string; calendar?: string }[];
}): string {
  const { days, events } = args;
  const n = events.length;

  if (n === 0) {
    return pick([
      `未来${days}天没有日程，挺空的～`,
      `接下来${days}天没什么安排，自由时间！`,
      `查了未来${days}天，日程表是空的。可以想做啥做啥。`,
    ]);
  }

  // 按日期分组
  const byDate = new Map<string, typeof events>();
  for (const e of events) {
    const list = byDate.get(e.date) || [];
    list.push(e);
    byDate.set(e.date, list);
  }

  const blocks: string[] = [];
  for (const [date, evts] of byDate) {
    blocks.push(`  📍 ${date}`);
    for (const e of evts) {
      const loc = e.location ? ` @${e.location}` : '';
      blocks.push(`    ${e.time}  ${e.title}${loc}`);
    }
  }
  const list = blocks.join('\n');

  const density = n / days;
  const densityComment = density > 3 ? pick(['排得挺密的。', '日程不少哦。', '注意节奏。']) :
                         density > 1 ? pick(['节奏正常。', '刚刚好。']) :
                         pick(['蛮轻松的。', '比较空。']);

  const templates = [
    () => `📅 未来${days}天共有${n}个日程——\n\n${list}\n\n${densityComment}`,
    () => {
      const opener = pick(['帮你翻了翻', '看了下', '查了一下']);
      return `${opener}接下来${days}天的日历：\n\n${list}\n\n${n}个安排，${densityComment}`;
    },
    () => `接下来${days}天的日程一览——\n\n${list}\n\n共${n}项。${densityComment}`,
  ];

  return pick(templates)();
}
