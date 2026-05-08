/**
 * Intent Classifier — Lumi's rule-based understanding layer.
 *
 * Classifies user input into intent categories WITHOUT calling any LLM.
 * This is the first stage of Lumi's independent cognitive pipeline.
 * The LLM is only invoked later for text generation, not for decision-making.
 */

export type IntentCategory =
  | 'command'       // Operational: open, list, run, create, delete
  | 'question'      // Information seeking
  | 'conversation'  // Casual chat, greeting, small talk
  | 'code'          // Code: read, write, fix, refactor, review
  | 'web'           // Web: search, fetch URL
  | 'file'          // File operations: read, list, find
  | 'system'        // System info, status
  | 'agent'         // Agent management: create, configure, list
  | 'unknown';      // Fallback — needs LLM

export interface IntentResult {
  category: IntentCategory;
  confidence: number;       // 0–1
  entities: Record<string, string>;  // Extracted entities (file names, URLs, queries, etc.)
  subIntent?: string;       // e.g. for command: "open", "create", "delete"
  needsLLM: boolean;        // Whether this intent requires LLM text generation
  directToolCall?: {        // If set, skip LLM and call this tool directly
    name: string;
    args: Record<string, any>;
  };
}

// ── Greeting / Small Talk Patterns ──
const GREETINGS = [
  /^(hi|hey|hello|你好|嗨|您好|喂|在吗|早上好|下午好|晚上好|good\s*(morning|afternoon|evening|night))[!！。.]*$/i,
  /^(lumi|Lumi)[!！。.]*$/,
  /^你(好|在|在吗|是谁|叫什么)/,
];

const SMALL_TALK = [
  /^(谢谢|感谢|多谢|thanks?|thank\s*you|thx)[!！。.]*$/i,
  /^(再见|拜拜|bye|goodbye|see\s*you|回头见|下次见)[!！。.]*$/i,
  /^(怎么样|如何|好吗|好吗？|ok\??|okay\??)$/i,
  /^(哈哈|呵呵|笑|有趣|好玩|有意思)/,
  /^(嗯|哦|好|ok|好的|知道了|明白了|懂了)/i,
];

// ── Command Patterns ──
const COMMAND_PATTERNS: Array<{ regex: RegExp; subIntent: string; tool?: string }> = [
  { regex: /(打开|启动|运行|开启|launch|open|start|run)\s*(程序|应用|app|软件)?\s*(.+)/i, subIntent: 'open', tool: 'desktop_open' },
  { regex: /(打开|浏览|访问|open)\s*(网页|网站|url|链接|link|网址)?\s*(https?:\/\/\S+)/i, subIntent: 'open_url', tool: 'desktop_open' },
  { regex: /(关闭|退出|停止|kill|stop|exit|quit|关掉)\s*(.+)/i, subIntent: 'close' },
  { regex: /(创建|新建|create|make|new|添加|add)\s*(文件|文件夹|目录|file|folder|dir)?\s*(.+)/i, subIntent: 'create', tool: 'write_file' },
  { regex: /(删除|移除|delete|remove|rm)\s*(文件|文件夹|目录)?\s*(.+)/i, subIntent: 'delete' },
  { regex: /(列出|显示|查看|list|show|display|ls|dir)\s*(桌面|desktop|文件|files?|目录|文件夹)/i, subIntent: 'list_files', tool: 'desktop_list_files' },
  { regex: /(截屏|截图|screenshot|capture)/i, subIntent: 'screenshot' },
];

// ── Question Patterns ──
const QUESTION_PATTERNS = [
  /^(什么|什么是|what\s+is|who\s+is|where\s+is|when\s+is|why\s+is|how\s+to|怎么|如何|为什么|怎样)/i,
  /\?|？/,
];

// ── Code Patterns ──
const CODE_PATTERNS: Array<{ regex: RegExp; subIntent: string }> = [
  { regex: /(修复|fix|debug|解决|bug)\s*(这个|那个|一下)?\s*(bug|错误|问题|error|issue)?/i, subIntent: 'fix' },
  { regex: /(重构|refactor|重写|rewrite|优化|optimize)\s*(代码|code|这个|那个)?/i, subIntent: 'refactor' },
  { regex: /(实现|implement|开发|develop|添加功能|add\s+feature)\s*(这个|那个|一下)?/i, subIntent: 'implement' },
  { regex: /(解释|explain|说明|这段代码|这个文件|这段)/i, subIntent: 'explain' },
  { regex: /(审查|review|检查|check)\s*(代码|code|这个|那个)?/i, subIntent: 'review' },
  { regex: /(测试|test|写测试|write\s+test|add\s+test)/i, subIntent: 'test' },
  { regex: /(提交|commit|push)\s*(代码|code|修改|changes?)?/i, subIntent: 'commit' },
];

// ── Web Patterns ──
const WEB_PATTERNS = [
  { regex: /(搜索|查找|search|find|查一下|搜一下|帮我搜)\s*(.+)/i, subIntent: 'web_search' },
  { regex: /(获取|fetch|抓取|读取)\s*(这个|那个)?\s*(网页|网站|url|链接|page)\s*(.+)/i, subIntent: 'url_fetch' },
];

// ── File Patterns ──
const FILE_PATTERNS = [
  { regex: /(读取|查看|显示|read|show|cat|打开)\s*(文件|file)\s*(.+)/i, subIntent: 'read_file' },
  { regex: /(搜索|查找|find|grep|search)\s*(在|in)?\s*(代码|code|文件|files?)\s*(中|里)?\s*(.+)/i, subIntent: 'grep' },
  { regex: /(写|write|保存|save|创建)\s*(文件|file|到)\s*(.+)/i, subIntent: 'write_file' },
];

// ── System Patterns ──
const SYSTEM_PATTERNS = [
  /^(系统|system)\s*(信息|info|状态|status|配置|config)/i,
  /(cpu|内存|memory|磁盘|disk|硬盘|空间|storage)/i,
  /(版本|version|升级|update|更新)/i,
];

// ── Agent Patterns ──
const AGENT_PATTERNS = [
  /(代理|agent|角色|personality|人格|助手)\s*(列表|list|创建|create|切换|switch|删除|delete|管理|manage)/i,
  /(create|make|new)\s*(agent|代理|助手|角色)/i,
];

export function classifyIntent(input: string): IntentResult {
  const text = input.trim();
  if (!text) {
    return { category: 'unknown', confidence: 0, entities: {}, needsLLM: true };
  }

  // 1. Greetings — pure conversation, high confidence
  for (const pattern of GREETINGS) {
    if (pattern.test(text)) {
      return {
        category: 'conversation',
        confidence: 0.95,
        entities: {},
        needsLLM: true, // LLM generates the greeting response, but Lumi already knows it's a greeting
      };
    }
  }

  // 2. Small talk
  for (const pattern of SMALL_TALK) {
    if (pattern.test(text)) {
      return {
        category: 'conversation',
        confidence: 0.85,
        entities: {},
        needsLLM: true,
      };
    }
  }

  // 3. Commands — many can skip LLM entirely
  for (const { regex, subIntent, tool } of COMMAND_PATTERNS) {
    const match = text.match(regex);
    if (match) {
      const target = (match[match.length - 1] || '').trim();
      const result: IntentResult = {
        category: 'command',
        confidence: 0.85,
        entities: { target },
        subIntent,
        needsLLM: true, // Default: let LLM handle
      };

      // Certain commands can skip LLM entirely
      if (tool && subIntent === 'open' && target) {
        const urlPattern = /^https?:\/\//i;
        result.directToolCall = {
          name: tool,
          args: { target: target, url: urlPattern.test(target) ? target : undefined },
        };
        result.needsLLM = false; // Lumi routes directly, no LLM needed
      }

      if (tool && subIntent === 'list_files') {
        result.directToolCall = { name: tool, args: {} };
        result.needsLLM = false;
      }

      return result;
    }
  }

  // 4. Web search
  for (const { regex, subIntent } of WEB_PATTERNS) {
    const match = text.match(regex);
    if (match) {
      const query = (match[match.length - 1] || '').trim();
      return {
        category: 'web',
        confidence: 0.8,
        entities: { query },
        subIntent,
        needsLLM: true, // LLM helps format search results
      };
    }
  }

  // 5. Code operations
  for (const { regex, subIntent } of CODE_PATTERNS) {
    if (regex.test(text)) {
      return {
        category: 'code',
        confidence: 0.75,
        entities: {},
        subIntent,
        needsLLM: true, // Code work always needs LLM
      };
    }
  }

  // 6. File operations
  for (const { regex, subIntent } of FILE_PATTERNS) {
    const match = text.match(regex);
    if (match) {
      const filePath = (match[match.length - 1] || '').trim();
      return {
        category: 'file',
        confidence: 0.8,
        entities: { filePath },
        subIntent,
        needsLLM: true,
      };
    }
  }

  // 7. System queries
  for (const pattern of SYSTEM_PATTERNS) {
    if (pattern.test(text)) {
      return {
        category: 'system',
        confidence: 0.75,
        entities: {},
        subIntent: 'info',
        directToolCall: { name: 'get_system_info', args: {} },
        needsLLM: false, // System info is deterministic, no LLM needed
      };
    }
  }

  // 8. Agent management
  for (const pattern of AGENT_PATTERNS) {
    if (pattern.test(text)) {
      return {
        category: 'agent',
        confidence: 0.75,
        entities: {},
        subIntent: 'manage',
        needsLLM: true,
      };
    }
  }

  // 9. Questions
  for (const pattern of QUESTION_PATTERNS) {
    if (pattern.test(text)) {
      return { category: 'question', confidence: 0.6, entities: {}, needsLLM: true };
    }
  }

  // 10. Default: unknown, needs LLM
  // Short messages are likely conversational
  if (text.length < 20) {
    return { category: 'conversation', confidence: 0.4, entities: {}, needsLLM: true };
  }

  return { category: 'unknown', confidence: 0.3, entities: {}, needsLLM: true };
}
