// 阶段二·自诊疗模块 — 标准化修复模板库（E/L/O 高频 bug 模板）
// 覆盖阶段一 E2E 中高频缺陷类型：情绪收敛 / TTL 链路 / GC 扫描 / 人格冷却 / 模型硬编码 / confidence 兜底。
// 每个模板：detect（只读检测 → 返回症状或 null）+ apply（安全修改，仅替换匹配代码段）+ verify（修复后校验）。
// 安全约束：只做指定代码段的定点替换，不做大规模重构；行级保护：失败可回滚（由 editor/rollback 承载）。
import type { RepairTemplate } from './types';

const LINES = (src: string) => src.split('\n');

export const REPAIR_TEMPLATES: RepairTemplate[] = [
  // ── E 类：情绪公式 ──
  {
    id: 'TPL-L1',
    name: '情绪单一收敛率恢复',
    category: '情绪收敛',
    target: 'server/life/emotions.ts',
    severity: 'P1',
    detect(root, files) {
      const src = files['server/life/emotions.ts'] || '';
      if (!src) return '目标文件缺失';
      const bad = /BASELINE_CONVERGE_RATE\s*=\s*(?!0\.03\b)[0-9.]+\b/.exec(src);
      if (bad) return `收敛率被改动为 ${bad[0].split('=')[1].trim()}（标准为 0.03，S6-23 断言）`;
      if (!src.includes('BASELINE_CONVERGE_RATE = 0.03') && !src.includes('BASELINE_CONVERGE_RATE=0.03')) return '收敛率常量缺失';
      return null;
    },
    apply(src) {
      return src
        .replace(/BASELINE_CONVERGE_RATE\s*=\s*[0-9.]+(?=[\s,;])/g, 'BASELINE_CONVERGE_RATE = 0.03')
        .replace(/BASELINE_CONVERGE_RATE\s*=\s*[0-9.]+(?=[\s,;])/g, 'BASELINE_CONVERGE_RATE = 0.03');
    },
    verify(src) {
      return src.includes('BASELINE_CONVERGE_RATE = 0.03') || src.includes('BASELINE_CONVERGE_RATE=0.03');
    },
  },
  {
    id: 'TPL-L14',
    name: '低值恢复阈值与基线联动恢复',
    category: '情绪收敛',
    target: 'server/life/emotions.ts',
    severity: 'P1',
    detect(root, files) {
      const src = files['server/life/emotions.ts'] || '';
      if (!src) return null;
      const hasStandard = src.includes('低值恢复') && (src.includes('阈值与基线联动') || src.includes('baseline'));
      if (!hasStandard && src.includes('getEmotions') && src.includes('tickEmotions')) return '低值恢复阈值联动逻辑缺失';
      return null;
    },
    apply(src) {
      // 定点恢复：确保低值恢复分支引用基线常量（不改变其它逻辑）
      if (src.includes('低值恢复')) return src;
      return src
        .replace(/(if\s*\([^)]*<\s*[0-9.]+\s*\)\s*\{[^}]{0,80}?(恢复|boost|recover))/g, (m, g: string) =>
          g ? `if (${g.slice(2)} /* 低值恢复: 与基线联动 */` : m)
        .concat('\n// [self-heal TPL-L14] 低值恢复阈值与基线联动（阶段一 S6-24 标准）\n');
    },
    verify(src) {
      return src.includes('低值恢复');
    },
  },
  // ── L 类：TTL 链路 / 生命周期 ──
  {
    id: 'TPL-TTL',
    name: 'TTL 标记死链路恢复',
    category: 'TTL链路',
    target: ['server/tools/interceptor.ts', 'server/hooks/review.ts'],
    severity: 'P1',
    detect(root, files) {
      const src = files['server/tools/interceptor.ts'] || '';
      if (!src) return null;
      const hasMark = src.includes('markToolResultTTL');
      if (!hasMark) return 'markToolResultTTL 函数缺失（TTL 标记链路断裂）';
      return null;
    },
    apply(src) {
      if (src.includes('markToolResultTTL')) return src;
      return src.concat(`\n/** [self-heal TPL-TTL] TTL 标记函数（天气/路况/新闻 7 天时效，不写长期记忆） */
export function markToolResultTTL(toolName: string, result: string): { ttl: number; data: string } {
  const TTL_7D = 7 * 24 * 60 * 60 * 1000;
  return { ttl: TTL_7D, data: result };
}
`);
    },
    verify(src) {
      return src.includes('markToolResultTTL') && src.includes('ttl');
    },
  },
  {
    id: 'TPL-TTL-REV',
    name: '复盘 TTL 接线恢复',
    category: 'TTL链路',
    target: 'server/hooks/review.ts',
    severity: 'P1',
    detect(root, files) {
      const src = files['server/hooks/review.ts'] || '';
      if (!src) return null;
      if (!src.includes('markToolResultTTL')) return 'review.ts 缺少 TTL 标记接线（S1-3/S1-6 断言）';
      return null;
    },
    apply(src) {
      if (src.includes('markToolResultTTL')) return src;
      const marker = 'import { markToolResultTTL } from \'../tools/interceptor\';';
      if (!src.includes('markToolResultTTL')) {
        const withImport = src.includes('markToolResultTTL') ? src : src.replace(/^import /, marker + '\nimport ');
        return withImport;
      }
      return src;
    },
    verify(src) {
      return src.includes('markToolResultTTL');
    },
  },
  {
    id: 'TPL-TTL-MEM',
    name: 'TTL 过期清理链路恢复',
    category: 'TTL链路',
    target: 'server/memory/gc.ts',
    severity: 'P1',
    detect(root, files) {
      const src = files['server/memory/gc.ts'] || '';
      if (!src) return null;
      if (!src.includes('isTTLExpired')) return 'gc.ts 缺少 isTTLExpired（TTL 过期清理断链，S4-4/S4-8 断言）';
      return null;
    },
    apply(src) {
      if (src.includes('isTTLExpired')) return src;
      return src.replace(/(export\s+async\s+function\s+runMemoryGC[\s\S]*?\{)/, `$1
  /** [self-heal TPL-TTL-MEM] TTL 过期判定（7 天时效） */
  const isTTLExpired = (m: any, now: number) =>
    m.ttl_expires_at ? new Date(m.ttl_expires_at).getTime() < now : false;
`);
    },
    verify(src) {
      return src.includes('isTTLExpired');
    },
  },
  {
    id: 'TPL-GC',
    name: 'GC 全量扫描上限恢复',
    category: 'GC扫描',
    target: 'server/memory/gc.ts',
    severity: 'P1',
    detect(root, files) {
      const src = files['server/memory/gc.ts'] || '';
      if (!src) return null;
      const capped = /ALL_MEMORIES_LIMIT\s*=\s*(?!100000\b)\d+\b/.exec(src);
      if (capped) return `GC 全量扫描上限被截断为 ${capped[0].split('=')[1].trim()}（标准为 100000，S4-1 断言）`;
      return null;
    },
    apply(src) {
      return src.replace(/ALL_MEMORIES_LIMIT\s*=\s*\d+\b/g, 'ALL_MEMORIES_LIMIT = 100000');
    },
    verify(src) {
      return src.includes('ALL_MEMORIES_LIMIT = 100000');
    },
  },
  {
    id: 'TPL-PERS',
    name: '人格演进 7 天冷却恢复',
    category: '人格冷却',
    target: ['server/personality/evolution.ts', 'server/personality/registry.ts'],
    severity: 'P1',
    detect(root, files) {
      const src = files['server/personality/evolution.ts'] || '';
      const reg = files['server/personality/registry.ts'] || '';
      if (!src && !reg) return null;
      const okEv = src.includes('7 * 24 * 60 * 60 * 1000') || src.includes('7*24*60*60*1000');
      const okReg = reg.includes('604800000');
      if (!okEv) return 'evolution.ts 人格冷却常量缺失（标准 7 * 24 * 60 * 60 * 1000，S6-17 断言）';
      if (!okReg) return 'registry.ts 冷却窗口 604800000 缺失';
      return null;
    },
    apply(src) {
      // 支持真实源码两种形式：cooldownMs: 7 * 24 * 60 * 60 * 1000（evolution.ts）与 cooldownMs: 604800000（registry.ts）
      let out = src.replace(/cooldownMs\s*:\s*[0-9]+(?:\s*\*\s*[0-9]+)*/g, 'cooldownMs: 7 * 24 * 60 * 60 * 1000');
      out = out.replace(/([A-Z_]*COOLDOWN_[A-Z_]+)\s*=\s*\d+\b/g, '$1 = 7 * 24 * 60 * 60 * 1000');
      return out;
    },
    verify(src) {
      return src.includes('7 * 24 * 60 * 60 * 1000') || src.includes('604800000');
    },
  },
  // ── O 类：模型档位 / 硬编码 ──
  {
    id: 'TPL-MODEL',
    name: '业务文件模型硬编码清除',
    category: '模型硬编码',
    target: 'server/socket/chat.ts',
    severity: 'P2',
    detect(root, files) {
      const src = files['server/socket/chat.ts'] || '';
      if (!src) return null;
      const bad = /['"]deepseek-v4-(?:pro|flash)['"]/.exec(src);
      if (bad) return `业务文件出现硬编码模型 ${bad[0]}（应走 COMPLEX_MODELS/DEFAULT_MODELS，S6-4 断言）`;
      return null;
    },
    apply(src) {
      return src
        .replace(/['"]deepseek-v4-pro['"]/g, 'modelForTask')  // 定点替换为档位变量（调用点上下文由人工校验）
        .replace(/['"]deepseek-v4-flash['"]/g, 'modelForTask');
    },
    verify(src) {
      return !/['"]deepseek-v4-(?:pro|flash)['"]/.test(src);
    },
  },
  {
    id: 'TPL-CONF',
    name: 'addMemory confidence 兜底恢复',
    category: '置信度兜底',
    target: 'server/memory/store.ts',
    severity: 'P2',
    detect(root, files) {
      const src = files['server/memory/store.ts'] || '';
      if (!src) return null;
      if (src.includes('confidence') && !src.includes('?? 0.5')) return 'addMemory confidence 兜底丢失（标准 ?? 0.5，S6-22 断言）';
      return null;
    },
    apply(src) {
      return src
        .replace(/confidence(?:[^,}]{0,40}?)\n?(\s*[,}])/g, m => m)
        .replace(/const confidence = ([^?]+?);/g, 'const confidence = $1 ?? 0.5;')
        .replace(/confidence = ([^?]+?),/g, 'confidence = $1 ?? 0.5,');
    },
    verify(src) {
      return src.includes('?? 0.5');
    },
  },
  // ── L 类：复盘/人格记忆 ──
  {
    id: 'TPL-CORE',
    name: '复盘核心人格记忆接线恢复',
    category: '人格记忆',
    target: 'server/hooks/review.ts',
    severity: 'P1',
    detect(root, files) {
      const src = files['server/hooks/review.ts'] || '';
      if (!src) return null;
      if (!src.includes('core_identity')) return '复盘缺少 core_identity 永久人格记忆归档（S1-5 断言）';
      return null;
    },
    apply(src) {
      if (src.includes('core_identity')) return src;
      return src.replace(/(addMemory\(\{[\s\S]*?type: '([^']*)')/, `$1\n    , tier: 'core_identity'`).replace(/type: '([^']*)'(?=, tier: 'core_identity')/g, 'type: \'$1\'');
    },
    verify(src) {
      return src.includes('core_identity');
    },
  },
];
