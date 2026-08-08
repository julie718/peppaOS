// 阶段三·模块3b — 隔离沙箱生成工坊（路径B执行器）
// 流程：缺口 keyword → 服务命名 → 标准模板生成 → 独立隔离目录落盘（sandbox_auto_mcp/）
// → tsc 迭代 5 轮自动修复 → 测试流水线（模块5）→ 人工审批（模块5）→ 7 天未审批自动过期清理。
//
// 隔离红线：沙箱目录位于数据根 sandbox_auto_mcp/，生成源码自包含零外部依赖，
// 不 import 主服务任何模块、不读写正式业务文件、不发起非公网请求（模板内嵌 SSRF 防护）。

import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { logger } from '../lib/logger';
import { appendAudit, getSandboxRoot, insertSandboxProject, listSandboxProjects, updateSandboxProject } from './database';
import { renderMcpSource, renderSandboxTsconfig, type McpTemplateParams } from './mcp_template';
import type { SandboxProject, SkillGap } from './types';

const execAsync = promisify(exec);
export const MAX_TSC_ITERATIONS = 5;     // tsc 迭代轮数上限
export const SANDBOX_EXPIRE_DAYS = 7;    // 7 天未审批自动清理

// ── 服务命名（keyword → 合法服务名） ──

const NAME_STOPWORDS = ['查', '看', '有没有', '一下', '多少', '什么', '怎么', '如何', '可以'];

export function nameService(keyword: string): string {
  const base = keyword
    .replace(/\s+/g, '_')
    .replace(/[^\w一-龥]/g, '')
    .split(/[_\s]/)
    .flatMap(w => NAME_STOPWORDS.includes(w) ? [] : [w])
    .join('_')
    .toLowerCase();
  const slug = base || 'generic';
  // 中文转拼音不可靠 → 用英文兜底名，保证合法标识符
  const ascii = slug.replace(/[一-龥]/g, '');
  const safe = (ascii || 'peppa_tool').replace(/^[^a-zA-Z]/, 'peppa_').slice(0, 40);
  return `skills_${safe}`;
}

// ── 沙箱项目创建 ──

export interface SandboxCreateInput {
  gap: SkillGap;
  /** 端点模板（{param} 占位） */
  endpointTemplate: string;
  method?: 'GET' | 'POST';
  description: string;
  /** 统一入参 schema */
  parameters: Record<string, { type: string; description: string; required?: boolean }>;
  /** 入参映射 */
  paramMap: Record<string, string>;
  /** 结果提取器函数体（入参 data） */
  extractorFn: string;
  /** 合规域 */
  complianceDomain: 'finance' | 'medical' | 'none';
  securityLevel?: 'safe' | 'confirm';
}

/** 创建沙箱项目：模板生成 → 隔离目录落盘 → DB 登记 */
export async function createSandboxProject(input: SandboxCreateInput): Promise<SandboxProject> {
  const serviceName = nameService(input.gap.keyword);
  const dir = path.join(getSandboxRoot(), serviceName);
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });

  const params: McpTemplateParams = {
    serviceName,
    description: input.description,
    parameters: input.parameters,
    endpointTemplate: input.endpointTemplate,
    method: input.method || 'GET',
    paramMap: input.paramMap,
    extractorFn: input.extractorFn,
    complianceDomain: input.complianceDomain,
    securityLevel: input.securityLevel || 'safe',
  };
  const mainSource = renderMcpSource(params);

  fs.writeFileSync(path.join(dir, 'src', 'index.ts'), mainSource, 'utf-8');
  fs.writeFileSync(path.join(dir, 'tsconfig.json'), renderSandboxTsconfig(), 'utf-8');
  fs.writeFileSync(path.join(dir, 'README.md'),
    `# ${serviceName} — 沙箱 MCP 自研工具\n\n对应缺口：${input.gap.keyword}（频次 ${input.gap.frequency}）\n\n- 状态：building（tsc 迭代 ≤ ${MAX_TSC_ITERATIONS} 轮）\n- 创建：${new Date().toISOString()}\n- 7 天未审批自动过期清理\n`, 'utf-8');

  const id = await insertSandboxProject({
    keyword: input.gap.keyword,
    serviceName,
    dir,
    mainSource,
    tscIterations: 0,
    tscPassed: false,
    status: 'building',
  });

  await appendAudit('sandbox_generate', serviceName, `缺口 ${input.gap.keyword} → ${dir}`);
  logger.info(`[SkillsSandbox] 沙箱项目创建: ${serviceName} (${dir})`);

  return {
    id,
    keyword: input.gap.keyword,
    serviceName,
    dir,
    mainSource,
    tscIterations: 0,
    tscPassed: false,
    status: 'building',
    createdAt: new Date().toISOString(),
  };
}

// ── tsc 迭代（5 轮自动修复） ──

function resolveTscBin(): string {
  const local = path.resolve(process.cwd(), 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc');
  if (fs.existsSync(local)) return local;
  return process.platform === 'win32' ? 'tsc.cmd' : 'tsc';
}

interface TscRun {
  passed: boolean;
  errors: string[];   // 形如 "src/index.ts(12,5): error TS2345: ..."
}

async function runTsc(dir: string): Promise<TscRun> {
  try {
    const { stderr } = await execAsync(`"${resolveTscBin()}" --noEmit -p "${path.join(dir, 'tsconfig.json')}"`, {
      timeout: 60_000,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    });
    void stderr;
    return { passed: true, errors: [] };
  } catch (e: any) {
    const out = (e?.stdout || '') + (e?.stderr || '');
    const errors = out.split('\n')
      .filter(l => /error TS\d+/.test(l))
      .map(l => l.trim())
      .slice(0, 40);
    return { passed: errors.length === 0, errors };
  }
}

/** 规则修复：按错误模式打补丁（无 LLM 时的确定性修复，覆盖模板生成代码的常见变异错误） */
function repairSource(source: string, errors: string[]): string {
  let s = source;
  // 未定义符号 → 清理该行（生成器注入的坏死代码）
  for (const err of errors) {
    const m = err.match(/error TS2304: Cannot find name '(\w+)'/);
    if (m) {
      s = s.split('\n').filter(l => !l.includes(m[1] + '(') && !l.includes(' ' + m[1] + ';') && !l.includes(m[1] + ' =')).join('\n');
    }
  }
  // 属性不存在（{} 类型）→ 提升为 any
  for (const err of errors) {
    const m = err.match(/error TS2339: Property '(\w+)' does not exist on type '\{\}'/);
    if (m) {
      s = s.split('\n').map(l => {
        if (l.includes(m[1])) return l.replace(/data\./g, '(data as any).');
        return l;
      }).join('\n');
    }
  }
  // 未使用变量 → 前置 void 表达式
  for (const err of errors) {
    const m = err.match(/error TS6133: '(\w+)' is declared but its value is never read/);
    if (m && !s.includes(`void ${m[1]};`)) {
      const lines = s.split('\n');
      const idx = lines.findIndex(l => l.includes(`const ${m[1]} =`) || l.includes(`let ${m[1]} =`) || l.includes(`function ${m[1]}(`));
      if (idx >= 0) {
        lines.splice(idx + 1, 0, `void ${m[1]};`);
        s = lines.join('\n');
      }
    }
  }
  return s;
}

/** 对沙箱项目执行 tsc 迭代（≤5 轮），更新 DB 状态 */
export async function iterateTsc(projectId: number, maxRounds = MAX_TSC_ITERATIONS): Promise<{
  passed: boolean;
  rounds: number;
  pendingReason: string;
}> {
  const projects = await listSandboxProjects();
  const project = projects.find(p => p.id === projectId);
  if (!project) throw new Error(`沙箱项目 ${projectId} 不存在`);
  const srcPath = path.join(project.dir, 'src', 'index.ts');
  if (!fs.existsSync(srcPath)) {
    await updateSandboxProject(projectId, { status: 'failed', pendingReason: '源码缺失' });
    return { passed: false, rounds: 0, pendingReason: '源码缺失' };
  }

  let source = fs.readFileSync(srcPath, 'utf-8');
  let rounds = 0;
  for (rounds = 1; rounds <= maxRounds; rounds++) {
    fs.writeFileSync(srcPath, source, 'utf-8');
    const run = await runTsc(project.dir);
    await updateSandboxProject(projectId, { tscIterations: rounds });
    if (run.passed) {
      await updateSandboxProject(projectId, { tscPassed: true, status: 'testing' });
      await appendAudit('test', project.serviceName, `tsc 第 ${rounds} 轮通过`);
      return { passed: true, rounds, pendingReason: '' };
    }
    const patched = repairSource(source, run.errors);
    if (patched === source) break; // 无可用补丁，提前终止
    source = patched;
  }

  const reason = `tsc 迭代 ${maxRounds} 轮未通过，需人工优化`;
  await updateSandboxProject(projectId, { tscPassed: false, status: 'building', pendingReason: reason });
  await appendAudit('test', project.serviceName, reason);
  return { passed: false, rounds: maxRounds, pendingReason: reason };
}

// ── 7 天过期清理 ──

/**
 * 清理超过 7 天仍未审批的沙箱项目（标记 expired + 审计；源码保留供审计追溯）。
 * 由 scheduler 每 6 小时巡检。
 */
export async function expireOldSandboxProjects(maxAgeDays = SANDBOX_EXPIRE_DAYS): Promise<number> {
  const projects = await listSandboxProjects();
  const cutoff = Date.now() - maxAgeDays * 24 * 3600 * 1000;
  let cleaned = 0;
  for (const p of projects) {
    if (p.status !== 'approved' && p.status !== 'expired' && p.status !== 'rejected') {
      const created = new Date(p.createdAt.replace(' ', 'T') + 'Z').getTime();
      if (!isNaN(created) && created < cutoff) {
        await updateSandboxProject(p.id, { status: 'expired' });
        await appendAudit('expire_cleanup', p.serviceName, `创建 ${p.createdAt} 超过 ${maxAgeDays} 天未审批，已过期清理`);
        cleaned++;
      }
    }
  }
  if (cleaned > 0) logger.info(`[SkillsSandbox] 过期清理 ${cleaned} 个沙箱项目（>${maxAgeDays} 天未审批）`);
  return cleaned;
}

/** 读取沙箱项目源码（供测试流水线/上线注册用） */
export async function readProjectSource(projectId: number): Promise<{ project: SandboxProject; source: string } | null> {
  const projects = await listSandboxProjects();
  const p = projects.find(x => x.id === projectId);
  if (!p) return null;
  const src = path.join(p.dir, 'src', 'index.ts');
  if (!fs.existsSync(src)) return null;
  return { project: p, source: fs.readFileSync(src, 'utf-8') };
}
