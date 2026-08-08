// 阶段二·自诊疗模块 — 缺陷自动溯源定位（四类故障源捕获）
// ①E2E断言失败 ②运行时异常 ③死代码 ④硬编码常量
// 对每类故障：全局 grep 调用链（谁引用了可疑符号）→ 归因文件/行号 → 已知/未知分类 + 分级告警。
import fs from 'fs';
import path from 'path';
import type { AssertionDef, Defect, DefectSeverity, RepairTemplate } from './types';

// ── 工具 ──

/** 生产源码扫描：仅后端 server/ + 根级入口（server.ts/db_layer.ts 等）；排除前端 src/、测试/脚本/文档/构建产物/自诊疗自身/快照 */
const SKIP_DIR = /node_modules|dist|\.git|self_heal|snapshots|test|tests|scripts|docs|\.claude|peppa_output|\.self_heal_snapshots|src|assets|components|data\//;

function walkTs(root: string): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIR.test(p)) stack.push(p);
      } else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts') && !e.name.endsWith('.d.ts')) {
        out.push(p);
      }
    }
  }
  return out;
}

/** 全仓生产 TS 源文件清单（含根级 server.ts 等；相对路径） */
export function walkSourceTree(root: string): string[] {
  return walkTs(root).map(abs => path.relative(root, abs).split(path.sep).join('/'));
}

function read(root: string, rel: string): string {
  const p = path.join(root, rel);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
}

/** 定位行号（首个匹配行，1 起） */
export function locateLine(content: string, pattern: string | RegExp): number {
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (pattern instanceof RegExp ? pattern.test(lines[i]) : lines[i].includes(pattern)) return i + 1;
  }
  return 0;
}

/** 全局 grep 调用链：返回所有引用 symbol 的文件:行（排除自身与注释行） */
export function scanReferences(root: string, symbol: string, excludeRel: string): Array<{ file: string; line: number }> {
  const hits: Array<{ file: string; line: number }> = [];
  for (const abs of walkTs(root)) {
    const rel = path.relative(root, abs).split(path.sep).join('/');
    if (rel === excludeRel) continue;
    const content = read(root, rel);
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (l.trim().startsWith('//') || l.trim().startsWith('*')) continue;
      if (l.includes(symbol)) hits.push({ file: rel, line: i + 1 });
    }
  }
  return hits;
}

// ── ① E2E 断言失败 → 结构化缺陷（归因文件取自断言定义，附全局调用链） ──

export function scanAssertionFailures(root: string, assertions: AssertionDef[], failedIds: string[], seq: { n: number }): Defect[] {
  const defects: Defect[] = [];
  for (const id of failedIds) {
    const a = assertions.find(x => x.id === id);
    if (!a) continue;
    const file = a.file || '';
    const line = file ? locateLine(read(root, file), a.name.replace(/^S\d+-\d+\s+/, '').slice(0, 6)) : 0;
    const refs = file ? scanReferences(root, path.basename(file, '.ts'), file) : [];
    const chain = refs.length ? `调用链: ${refs.slice(0, 3).map(r => `${r.file}:${r.line}`).join(' → ')}` : '调用链: 无上游引用（可能已死链）';
    defects.push({
      id: `D${seq.n.toString().padStart(4, '0')}`,
      source: 'assertion_failure',
      category: 'unknown',
      severity: 'P1',
      file,
      line,
      symptom: `标准断言 ${id}（${a.name}）执行失败。${chain}`,
      criterion: `离线断言 ${id} 必须通过（阶段一原始标准映射）`,
      autoRepairable: false,
      humanRequired: false, // 分类后由模板匹配决定是否可自动修复
      resolved: false,
    });
    seq.n++;
  }
  return defects;
}

// ── ② 运行时异常 ──

/** ② 运行时异常（外部错误缓冲/注入）→ 结构化缺陷 */
export function scanRuntimeErrors(root: string, errors: Array<{ message: string; stack?: string }>, seq: { n: number }): Defect[] {
  const defects: Defect[] = [];
  for (const err of errors) {
    const stackFile = (err.stack || '').match(/\(?([^():]+\.ts):(\d+)/);
    const file = stackFile ? stackFile[1].replace(/^.*?\/server\//, 'server/') : '';
    defects.push({
      id: `D${seq.n.toString().padStart(4, '0')}`,
      source: 'runtime_error',
      category: 'unknown',
      severity: 'P1',
      file,
      line: stackFile ? Number(stackFile[2]) : 0,
      symptom: `运行时异常: ${err.message.slice(0, 200)}`,
      criterion: '服务运行期不应抛出未捕获异常',
      autoRepairable: false,
      humanRequired: true,
      resolved: false,
    });
    seq.n++;
  }
  return defects;
}

// ── ③ 死代码 ──

/**
 * ③ 死代码检测（保守策略，避免误报）：
 *   a. 大段整块注释（≥15 连续行）——疑似被注释掉的业务代码
 *   b. 导出符号全仓零引用（排除自身定义行）——疑似死链路
 * 结果默认 humanRequired（未知类），若后续模板命中则升级为自动修复。
 */
export function scanDeadCode(root: string, files: string[], seq: { n: number }): Defect[] {
  const defects: Defect[] = [];
  for (const rel of files) {
    const content = read(root, rel);
    if (!content) continue;
    // a. 大段块注释
    const lines = content.split('\n');
    let block = 0, blockStart = 0;
    for (let i = 0; i < lines.length; i++) {
      const t = lines[i].trim();
      const isComment = t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
      if (isComment) {
        if (block === 0) blockStart = i + 1;
        block++;
      } else {
        if (block >= 15 && !/^\s*[/*\s-]*$/.test(lines[blockStart - 1]) && !lines[blockStart - 1].includes('⚠️') && !lines[blockStart - 1].includes('===') && !lines[blockStart - 1].includes('━━')) {
          defects.push({
            id: `D${seq.n.toString().padStart(4, '0')}`,
            source: 'dead_code',
            category: 'unknown',
            severity: 'P3',
            file: rel,
            line: blockStart,
            symptom: `疑似死代码: ${block} 行整块注释（可能被注释掉的业务逻辑）`,
            criterion: '正式代码库不应保留大段注释业务块（修复需人工确认后删除或恢复）',
            autoRepairable: false,
            humanRequired: true,
            resolved: false,
          });
          seq.n++;
        }
        block = 0;
      }
    }
    // b. 未使用导出符号（保守：仅函数/常量 export；引用检查覆盖全仓含根级文件）
    const exports = new Set<string>();
    const expRe = /export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)|export\s+const\s+([A-Za-z_$][\w$]*)/g;
    let m: RegExpExecArray | null;
    while ((m = expRe.exec(content))) exports.add(m[1] || m[2]);
    // 预读全仓文件（含根级 server.ts），统计每个符号被多少个文件引用（排除注释行）
    const allFiles = walkSourceTree(root);
    const symRefCount = new Map<string, number>();
    for (const other of allFiles) {
      if (other === rel) continue;
      const otherContent = read(root, other);
      if (!otherContent) continue;
      for (const sym of exports) {
        if (otherContent.includes(sym)) symRefCount.set(sym, (symRefCount.get(sym) || 0) + 1);
      }
    }
    for (const sym of exports) {
      if (sym.length < 3) continue; // 短名符号（如 db/x）子串匹配误报率高，不判死代码
      const inSame = content.split('\n').filter(l => !l.trim().startsWith('//')).filter(l => l.includes(sym)).length;
      if (inSame <= 1 && !symRefCount.has(sym)) {
        const line = locateLine(content, sym);
        defects.push({
          id: `D${seq.n.toString().padStart(4, '0')}`,
          source: 'dead_code',
          category: 'unknown',
          severity: 'P3',
          file: rel,
          line,
          symptom: `疑似死代码: 导出符号 ${sym} 全仓零引用`,
          criterion: '导出的函数/常量若全仓无人调用则属于死链路（修复需人工确认后清理或接线）',
          autoRepairable: false,
          humanRequired: true,
          resolved: false,
        });
        seq.n++;
      }
    }
  }
  return defects;
}

// ── ④ 硬编码常量 ──

/**
 * ④ 硬编码常量检测：
 *   a. 业务文件（chat/voice/task 之外）出现 'deepseek-v4-pro' 等模型名硬编码（非注释行）
 * 与阶段一 S6-4/5/6（O-1 模型档位）断言同一标准。
 */
const MODEL_HARDCODE_NAMES = ['deepseek-v4-pro', 'deepseek-v4-flash', 'deepseek-v4'];
const MODEL_EXEMPT_FILES = [
  'server/socket/chat.ts', 'server/socket/voice.ts', 'server/socket/task.ts',
  'server/self_heal/', 'server/llm/', 'server/config/', 'scripts/', 'server/agents/',
];

export function scanHardcodedConsts(root: string, files: string[], seq: { n: number }): Defect[] {
  const defects: Defect[] = [];
  for (const rel of files) {
    if (MODEL_EXEMPT_FILES.some(fx => rel.includes(fx))) continue;
    const content = read(root, rel);
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      const t = l.trim();
      if (t.startsWith('//') || t.startsWith('*')) continue;
      for (const name of MODEL_HARDCODE_NAMES) {
        if (t.includes(`'${name}'`) || t.includes(`"${name}"`)) {
          defects.push({
            id: `D${seq.n.toString().padStart(4, '0')}`,
            source: 'hardcoded_const',
            category: 'unknown',
            severity: 'P2',
            file: rel,
            line: i + 1,
            symptom: `硬编码模型常量 ${name}（应走 COMPLEX_MODELS/DEFAULT_MODELS 档位）`,
            criterion: '模型选择必须走模型档位，禁止业务文件硬编码（阶段一 O-1 标准）',
            autoRepairable: false,
            humanRequired: true,
            resolved: false,
          });
          seq.n++;
        }
      }
    }
  }
  return defects;
}

// ── 已知缺陷分类（模板匹配） ──

/**
 * 已知高频 bug 分类：用修复模板库的 detect 对缺陷做二次匹配。
 * 命中 → category='known'、autoRepairable=true、severity 按模板、templateId 记录。
 */
export function classifyKnownDefects(defects: Defect[], templates: RepairTemplate[], root: string): Defect[] {
  for (const d of defects) {
    if (!d.file || !fs.existsSync(path.join(root, d.file))) continue;
    const content = read(root, d.file);
    for (const tpl of templates) {
      const targetHit = (Array.isArray(tpl.target) ? tpl.target : [tpl.target]).some(t => t === d.file || d.file.endsWith(t));
      if (!targetHit) continue;
      try {
        const symptom = tpl.detect(root, { [d.file]: content });
        if (symptom) {
          d.category = 'known';
          d.templateId = tpl.id;
          d.autoRepairable = true;
          d.humanRequired = false;
          d.severity = tpl.severity;
          d.symptom = `${d.symptom} → 模板 ${tpl.id}（${tpl.name}）命中: ${symptom}`;
        }
      } catch { /* 模板自身异常不影响分类 */ }
    }
  }
  return defects;
}
