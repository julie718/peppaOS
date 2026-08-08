// ═══════════════════════════════════════════════════════════════════════
// 阶段三·自主技能拓展系统 全套 E2E（8 场景）
//   1. 检索评分：七维评估 / 任一 <0.6 淘汰 / 路径A优先（复用 > 自研，优先级锁定）
//   2. 外部适配：适配暂存 → 测试 → 审批 → 热加载上线（批准前不进工具池）
//   3. 沙箱生成：隔离目录 / 标准模板 / tsc 迭代 ≤5 轮
//   4. 密钥录入：AES-256-GCM 加密 / 明文不出网关 / 代理调用 / 限流
//   5. 审批上线：批准 / 驳回修改 / 暂存 7 天清理
//   6. 故障自修复：延迟/失败率/负面情绪 → 复测 → 回滚/下线
//   7. 版本升级回滚：升级冒烟失败 → 自动回滚旧版本
//   8. 网络降级异常：5xx 重试 / 超时 / SSRF 拦截 / 响应截断
// 运行：TZ=America/New_York npx tsx stage3_skills_extension.test.ts
// 隔离：全部指向 /tmp/stage3_e2e（数据库/沙箱零接触正式数据）
// ═══════════════════════════════════════════════════════════════════════
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ── 隔离环境 ──
const TMP = path.join(os.tmpdir(), 'stage3_e2e');
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });
process.env.SKILLS_DB_PATH = path.join(TMP, 'skills.db');
process.env.SANDBOX_MCP_DIR = path.join(TMP, 'sandbox_auto_mcp');
process.env.SKILLS_GATEWAY_RATE_PER_MIN = '2'; // 限流测试用小阈值（import 前设置）

let passed = 0;
const failed: string[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) { passed++; console.log(`  ✅ ${name}`); }
  else { failed.push(name); console.log(`  ❌ ${name} ${detail}`); }
}

// ── 工具池引用（热加载验证） ──
const { toolRegistry } = await import('./server/tools/registry');

// ═══════════ 场景 1：检索 + 七维评分 + 路径A优先 ═══════════
async function scene1() {
  console.log('\n━━━ 场景1：检索评分（七维 + 淘汰 + 路径A优先） ━━━');
  const { searchAndDecide, assessSevenDims } = await import('./server/skills_extension/search_engine');

  // 七维判定单元：任一 <0.6 淘汰
  const okDims = assessSevenDims({ stability: 0.8, maintenance: 0.8, errorRate: 0.8, compliance: 0.8, cost: 0.9, protocolFit: 0.8, userMatch: 0.8 });
  check('七维全达标 → 合格', okDims.eligible);
  const badDims = assessSevenDims({ stability: 0.3, maintenance: 0.8, errorRate: 0.8, compliance: 0.8, cost: 0.9, protocolFit: 0.8, userMatch: 0.8 });
  check('任一维度 <0.6 → 淘汰', !badDims.eligible);
  check('淘汰原因带维度与分数', badDims.disqualifyReasons.some(r => r.startsWith('stability=0.30')), badDims.disqualifyReasons.join(';'));

  // 集成检索（注册表缓存源，离线可用）
  const { eligible, disqualified, decision, all } = await searchAndDecide(['美股']);
  check('检索命中候选', all.length >= 1, `候选=${all.length}`);
  check('合格候选七维全部 ≥0.6', eligible.length > 0 && eligible.every(c => Object.values(c.scores).every(v => v >= 0.6)));
  check('路径A优先（decision=reuse）', decision === 'reuse', `decision=${decision}`);
  check('淘汰候选带原因', disqualified.every(d => d.disqualifyReasons.length > 0));

  // 无合格候选 → 路径B兜底（优先级未颠倒）
  const none = assessSevenDims({ stability: 0.1, maintenance: 0.1, errorRate: 0.1, compliance: 0.1, cost: 0.1, protocolFit: 0.1, userMatch: 0.1 });
  check('全维不达标 → 走自研兜底判定', !none.eligible);

  // 缺口识别（M1：记忆+交互语料 → 数据驱动候选）
  const { detectGaps } = await import('./server/skills_extension/gap_detector');
  const gaps = await detectGaps();
  check('缺口识别执行（审计 gap_detected）', gaps.sources.memory >= 0 && gaps.sources.interactions >= 0, JSON.stringify(gaps.sources));
}

// ═══════════ 场景 2：外部适配（路径A执行：暂存 → 测试 → 审批 → 热加载） ═══════════
async function scene2() {
  console.log('\n━━━ 场景2：外部适配 + 热加载（批准前不进工具池） ━━━');
  const { searchAndDecide } = await import('./server/skills_extension/search_engine');
  const { adaptCandidate, getStagedTestableTool, listStagedAdaptations, listAdapterVersions } = await import('./server/skills_extension/adapter');
  const { runTestPipeline } = await import('./server/skills_extension/test_pipeline');
  const { submitForApproval, decideApproval, isInToolPool, listPendingApprovals } = await import('./server/skills_extension/approval');
  const { listAudit } = await import('./server/skills_extension/database');

  const { eligible } = await searchAndDecide(['美股']);
  const cand = eligible[0];
  const adapt = await adaptCandidate(cand, {
    toolName: cand.name, serviceName: cand.name, origin: cand.origin,
    endpointTemplate: 'https://api.example.test/quote?symbol={symbol}',
    paramMap: { symbol: 'symbol' },
    extractor: (data: any) => `报价: ${JSON.stringify(data)}`,
    complianceDomain: 'finance', needsCredential: false,
    description: '美股实时报价', securityLevel: 'safe',
  });
  check('适配暂存成功', adapt.ok, adapt.message);
  check('暂存登记可见', listStagedAdaptations().some(s => s.toolName === cand.name));
  check('批准前未进入工具池', !isInToolPool(cand.name) && !toolRegistry.get(cand.name));
  check('适配快照已落盘审计', !!adapt.snapshotPath && fs.existsSync(adapt.snapshotPath!));

  const staged = getStagedTestableTool(cand.name)!;
  const report = await runTestPipeline(staged);
  check('6 类用例全部通过', report.gatePassed, `${report.passed}/${report.total}`);
  check('测试报告含 6 类以上用例', report.cases.length >= 6);

  const sub = await submitForApproval(null, cand.name, report);
  check('测试通过 → 提交审批', sub.ok, sub.message);
  check('审批来源标记 adapt:', (await listPendingApprovals()).some(a => a.projectId === `adapt:${cand.name}`));

  const dec = await decideApproval(sub.approvalId!, 'approved', 'e2e');
  check('批准 → 上线（进入工具池）', dec.ok && isInToolPool(cand.name), dec.message);
  const def = toolRegistry.get(cand.name);
  check('上线工具可执行', !!def && typeof def.handler === 'function');
  check('版本 v1.0.0 记录', listAdapterVersions(cand.name).some(v => v.version === '1.0.0'));
  const audit = await listAudit();
  check('审计含 adapt/approve/deploy', ['adapt', 'approve', 'deploy'].every(a => audit.some(e => e.action === a)), audit.map(a => a.action).join(','));
  return cand.name;
}

// ═══════════ 场景 3：沙箱生成（隔离目录 + 标准模板 + tsc 迭代） ═══════════
async function scene3() {
  console.log('\n━━━ 场景3：沙箱生成 + tsc 迭代 ━━━');
  const { createSandboxProject, iterateTsc, nameService } = await import('./server/skills_extension/sandbox');
  const { renderMcpSource } = await import('./server/skills_extension/mcp_template');
  const { loadSandboxTool } = await import('./server/skills_extension/test_pipeline');
  const { listSandboxProjects } = await import('./server/skills_extension/database');

  const svc = nameService('美股行情');
  check('服务命名合法标识符', /^skills_[a-z_]+$/.test(svc), svc);

  // 模板渲染：自包含 + 零外部依赖 + SSRF 内嵌
  const src = renderMcpSource({
    serviceName: 'skills_fx_test', description: '汇率查询',
    parameters: { pair: { type: 'string', description: '货币对', required: true } },
    endpointTemplate: 'https://api.example.test/fx?pair={pair}',
    paramMap: { pair: 'pair' },
    extractorFn: 'const d = data as any; return "1 " + d.pair + " = " + d.rate;',
    complianceDomain: 'finance', securityLevel: 'safe',
  });
  check('模板源码零外部依赖（无 import 语句）', !/import\s/.test(src));
  check('模板内嵌 SSRF 防护', src.includes('禁止访问内网地址'));
  check('模板强制免责注入', src.includes('不构成任何投资建议'));

  // 真实沙箱项目
  const proj = await createSandboxProject({
    gap: { id: 'gap_fx', keyword: '汇率', evidence: ['查一下汇率'], frequency: 5, lastSeenAt: new Date().toISOString(), status: 'pending', createdAt: new Date().toISOString() },
    endpointTemplate: 'https://api.example.test/fx?pair={pair}',
    description: '实时汇率查询', parameters: { pair: { type: 'string', description: '货币对' } },
    paramMap: { pair: 'pair' },
    extractorFn: 'const d = data as any; return "1 " + d.pair + " = " + d.rate;',
    complianceDomain: 'finance', securityLevel: 'safe',
  });
  check('沙箱目录在隔离根下', proj.dir.startsWith(process.env.SANDBOX_MCP_DIR!), proj.dir);
  check('目录含源码+tsconfig+README', ['src/index.ts', 'tsconfig.json', 'README.md'].every(f => fs.existsSync(path.join(proj.dir, f))));

  const iter = await iterateTsc(proj.id);
  check(`tsc 迭代通过（${iter.rounds} 轮 ≤5）`, iter.passed && iter.rounds <= 5, iter.pendingReason);
  const db = await listSandboxProjects();
  check('DB 记录 tsc 通过', db.find(p => p.id === proj.id)?.tscPassed === true);

  const tool = await loadSandboxTool(proj.id);
  check('沙箱工具可动态加载', !!tool && typeof tool.handler === 'function');
  check('沙箱工具元数据就绪', tool!.complianceDomain === 'finance' && tool!.endpointTemplate.includes('fx'), JSON.stringify(tool?.endpointTemplate));

  // 5 轮失败的修复路径：注入坏死代码 → iterateTsc 应 5 轮标记人工优化
  const badPath = path.join(proj.dir, 'src', 'index.ts');
  fs.writeFileSync(badPath, 'import { nonexistent } from "./never";\nconst x: number = "str";\n' + src, 'utf-8');
  const bad = await iterateTsc(proj.id);
  check('坏死代码 5 轮后标记人工优化', !bad.passed && bad.pendingReason.includes('人工优化'), bad.pendingReason);
  const db2 = await listSandboxProjects();
  check('DB 记录 pending 原因', db2.find(p => p.id === proj.id)?.pendingReason?.includes('人工优化'));
  return proj.id;
}

// ═══════════ 场景 4：密钥录入（AES-256-GCM + 网关代理 + 限流） ═══════════
async function scene4() {
  console.log('\n━━━ 场景4：密钥录入 + 授权网关代理 + 限流 ━━━');
  const { setCredential, removeCredential, listCredentialMeta, proxyFetch, encryptSecret, decryptSecret, registerAuthInjector, getBillingStats } = await import('./server/skills_extension/auth_gateway');
  const { getCredentialByService } = await import('./server/skills_extension/database');
  const { listAudit } = await import('./server/skills_extension/database');
  const { registerMockEndpoint } = await import('./server/skills_extension/test_pipeline');

  const SECRET = 'sk-live-9f8e7d6c5b4a';
  await setCredential('paid-news-api', SECRET);
  const stored = await getCredentialByService('paid-news-api')!;
  check('密文不落明文', !!stored && !stored.encryptedKey.includes('sk-live') && stored.encryptedKey.split(':').length === 3);
  check('解密往返一致', decryptSecret(stored!.encryptedKey) === SECRET);
  check('审计不含密钥片段', (await listAudit()).every(e => !e.detail.includes('sk-live')));
  const meta = await listCredentialMeta();
  check('元信息列表不含密文', meta.every(m => !JSON.stringify(m).includes('sk-live')));

  // 网关代理：注入认证头（明文只在网关内）
  let seenAuth = '';
  registerAuthInjector('paid-news-api', (cred) => { seenAuth = cred; return { 'X-Api-Key': cred }; });
  registerMockEndpoint({ url: 'https://api.paid.example/news', body: { items: ['news1'] } });
  const resp = await proxyFetch('paid-news-api', 'https://api.paid.example/news?limit=3', { method: 'GET' });
  const body = await resp.json();
  check('代理返回外部数据', Array.isArray(body.items));
  check('认证头注入正确', seenAuth === SECRET);
  check('计费统计 +1', getBillingStats().find(b => b.serviceName === 'paid-news-api')?.calls === 1);

  // 限流（RATE=2/min）
  await proxyFetch('paid-news-api', 'https://api.paid.example/news?limit=1', { method: 'GET' }).catch(() => {});
  let limited = false;
  try { await proxyFetch('paid-news-api', 'https://api.paid.example/news?limit=1', { method: 'GET' }); }
  catch { limited = true; }
  check('超限被拒绝（限流生效）', limited);
  check('未授权服务被拒', !(await proxyFetch('unknown-service', 'https://x.example', {}).then(() => true).catch(() => false)));
  check('删除密钥', await removeCredential('paid-news-api'));
  check('删除后不可代理', !(await proxyFetch('paid-news-api', 'https://api.paid.example/news', {}).then(() => true).catch(() => false)));

  const ct = encryptSecret('tamper-check-1');
  let tamperFail = false;
  try { decryptSecret(ct.slice(0, -1) + (ct.endsWith('A') ? 'B' : 'A')); } catch { tamperFail = true; }
  check('密文篡改解密失败（完整性保护）', tamperFail);
}

// ═══════════ 场景 5：审批三选项 ═══════════
async function scene5() {
  console.log('\n━━━ 场景5：人工审批闸门（批准/驳回修改/暂存 7 天清理） ━━━');
  const { createSandboxProject, iterateTsc } = await import('./server/skills_extension/sandbox');
  const { loadSandboxTool, runTestPipeline, makeSandboxRepair } = await import('./server/skills_extension/test_pipeline');
  const { submitForApproval, decideApproval, listPendingApprovals, expireStaleApprovals, isInToolPool } = await import('./server/skills_extension/approval');
  const { expireOldSandboxProjects } = await import('./server/skills_extension/sandbox');
  const { listSandboxProjects } = await import('./server/skills_extension/database');

  // ── 驳回修改链路 ──
  const proj = await createSandboxProject({
    gap: { id: 'gap_reject', keyword: '新闻', evidence: ['看看新闻'], frequency: 2, lastSeenAt: new Date().toISOString(), status: 'pending', createdAt: new Date().toISOString() },
    endpointTemplate: 'https://api.example.test/news?tag={tag}',
    description: '资讯聚合', parameters: { tag: { type: 'string', description: '分类' } },
    paramMap: { tag: 'tag' },
    extractorFn: 'const d = data as any; return d.items?.join("\\n") || "无结果";',
    complianceDomain: 'none', securityLevel: 'safe',
  });
  await iterateTsc(proj.id);
  const tool = (await loadSandboxTool(proj.id))!;
  const report = await runTestPipeline(tool, { projectId: proj.id, repair: makeSandboxRepair(proj.id) });
  const sub = await submitForApproval(proj.id, tool.name, report);
  check('沙箱项目测试通过 → 提交审批', sub.ok, sub.message);

  const rejectEmpty = await decideApproval(sub.approvalId!, 'rejected', 'e2e');
  check('驳回必须附意见', !rejectEmpty.ok);
  const rejected = await decideApproval(sub.approvalId!, 'rejected', 'e2e', '数据源需增加汇率字段');
  check('驳回修改 → 携带意见', rejected.ok && rejected.status === 'rejected');
  const projAfterReject = (await listSandboxProjects()).find(p => p.id === proj.id);
  check('项目退回工坊并记录意见', projAfterReject!.status === 'building' && projAfterReject!.pendingReason?.includes('汇率字段'), projAfterReject!.pendingReason);
  check('驳回后不在工具池', !isInToolPool(tool.name));
  check('驳回后不可再次审批', !(await decideApproval(sub.approvalId!, 'approved', 'e2e')).ok);

  // ── 批准链路（场景2 的适配器审批已被批准上线）──
  const { listApprovals } = await import('./server/skills_extension/database');
  const allApprovals = await listApprovals();
  const adapterApproved = allApprovals.find(a => a.projectId.startsWith('adapt:') && a.status === 'approved');
  check('适配器工具审批记录为 approved', !!adapterApproved);
  if (adapterApproved) {
    check('适配器工具已进入工具池', isInToolPool(adapterApproved.toolName));
  }
  // 新增一个适配器审批走 hold → 验证与沙箱相同的暂存清理
  const { adaptCandidate, getStagedTestableTool } = await import('./server/skills_extension/adapter');
  const { searchAndDecide } = await import('./server/skills_extension/search_engine');
  const { eligible } = await searchAndDecide(['汇率']);
  const cand2 = eligible[0];
  await adaptCandidate(cand2, {
    toolName: cand2.name, serviceName: cand2.name, origin: cand2.origin,
    endpointTemplate: 'https://api.example.test/fx3?pair={pair}',
    paramMap: { pair: 'pair' },
    extractor: (data: any) => `汇率: ${JSON.stringify(data)}`,
    complianceDomain: 'finance', needsCredential: false,
    description: '汇率查询', securityLevel: 'safe',
  });
  const report2 = await runTestPipeline(getStagedTestableTool(cand2.name)!);
  const sub2 = await submitForApproval(null, cand2.name, report2);
  check('新适配器审批提交', sub2.ok);
  const held2 = await decideApproval(sub2.approvalId!, 'hold', 'e2e');
  check('适配器审批可暂存', held2.ok && held2.status === 'pending', held2.message);

  // ── 暂存 + 7 天清理链路 ──
  const projHold = await createSandboxProject({
    gap: { id: 'gap_hold', keyword: '天气', evidence: ['天气如何'], frequency: 3, lastSeenAt: new Date().toISOString(), status: 'pending', createdAt: new Date().toISOString() },
    endpointTemplate: 'https://api.example.test/weather?city={city}',
    description: '天气预报', parameters: { city: { type: 'string', description: '城市' } },
    paramMap: { city: 'city' },
    extractorFn: 'const d = data as any; return d.temp + "℃";',
    complianceDomain: 'none', securityLevel: 'safe',
  });
  await iterateTsc(projHold.id);
  const toolHold = (await loadSandboxTool(projHold.id))!;
  const reportHold = await runTestPipeline(toolHold, { projectId: projHold.id, repair: makeSandboxRepair(projHold.id) });
  const subHold = await submitForApproval(projHold.id, toolHold.name, reportHold);
  const held = await decideApproval(subHold.approvalId!, 'hold', 'e2e');
  check('暂存保持待审', held.ok && held.status === 'pending', held.message);
  check('暂存项目仍为 awaiting_approval', (await listSandboxProjects()).find(p => p.id === projHold.id)?.status === 'awaiting_approval');

  const cleaned = await expireStaleApprovals(0); // 0 天 → 全部待审过期
  check('暂存 7 天过期清理（审批记录）', cleaned >= 1, `cleaned=${cleaned}`);
  const projExpired = (await listSandboxProjects()).find(p => p.id === projHold.id);
  check('过期项目标记 expired', projExpired!.status === 'expired', projExpired!.status);
  const expired = await expireOldSandboxProjects(0);
  check('过期沙箱清理计数', expired >= 1);
  const staleAfter = (await listPendingApprovals()).filter(a => a.projectId.startsWith('adapt:') || a.projectId === '0');
  check('过期清理后待审清零', staleAfter.length === 0);
}

// ═══════════ 场景 6：故障自修复 ═══════════
async function scene6() {
  console.log('\n━━━ 场景6：监控 + 故障自修复 ━━━');
  const { recordToolResult, getToolHealthSnapshot, autoRemediate } = await import('./server/skills_extension/monitoring');
  const { toolRegistry } = await import('./server/tools/registry');
  const { listMetricSummary } = await import('./server/skills_extension/database');
  const { adaptCandidate, getStagedTestableTool } = await import('./server/skills_extension/adapter');
  const { runTestPipeline } = await import('./server/skills_extension/test_pipeline');
  const { submitForApproval, decideApproval, isInToolPool } = await import('./server/skills_extension/approval');
  const { searchAndDecide } = await import('./server/skills_extension/search_engine');

  // 上线一个"故障工具"（批准后插入 6 条 error 指标）
  const { eligible } = await searchAndDecide(['汇率']);
  const cand = eligible[0];
  await adaptCandidate(cand, {
    toolName: cand.name, serviceName: cand.name, origin: cand.origin,
    endpointTemplate: 'https://api.example.test/fx2?pair={pair}',
    paramMap: { pair: 'pair' },
    extractor: (data: any) => `汇率: ${JSON.stringify(data)}`,
    complianceDomain: 'finance', needsCredential: false,
    description: '汇率查询', securityLevel: 'safe',
  });
  const report = await runTestPipeline(getStagedTestableTool(cand.name)!);
  const sub = await submitForApproval(null, cand.name, report);
  await decideApproval(sub.approvalId!, 'approved', 'e2e');
  check('故障工具已上线', isInToolPool(cand.name));

  for (let i = 0; i < 6; i++) await recordToolResult(cand.name, 'error', 5000);
  const snap = await getToolHealthSnapshot(cand.name);
  check('故障判定 degraded', snap.verdict === 'degraded', `verdict=${snap.verdict} failureRate=${snap.failureRate}`);
  check('延迟均值被监控', snap.avgLatencyMs >= 4000, `avg=${snap.avgLatencyMs}`);

  const r = await autoRemediate(cand.name);
  check('自修复执行（无旧版本 → 下线）', r.action === 'removed', `${r.action}: ${r.detail}`);
  check('故障工具已从工具池移除', !isInToolPool(cand.name));
  const summary = await listMetricSummary();
  check('监控统计可查询', summary.some(s => s.toolName === cand.name && s.errors >= 6));
}

// ═══════════ 场景 7：版本升级回滚 ═══════════
async function scene7() {
  console.log('\n━━━ 场景7：版本升级 + 冒烟失败自动回滚 ━━━');
  const { adaptCandidate, getStagedTestableTool, upgradeTool, listAdapterVersions } = await import('./server/skills_extension/adapter');
  const { runTestPipeline } = await import('./server/skills_extension/test_pipeline');
  const { submitForApproval, decideApproval } = await import('./server/skills_extension/approval');
  const { searchAndDecide } = await import('./server/skills_extension/search_engine');
  const { toolRegistry } = await import('./server/tools/registry');
  const { listAudit } = await import('./server/skills_extension/database');

  const { eligible } = await searchAndDecide(['新闻']);
  const cand = eligible.find(c => c.name === 'global-news-mcp') || eligible[0];
  await adaptCandidate(cand, {
    toolName: cand.name, serviceName: cand.name, origin: cand.origin,
    endpointTemplate: 'https://api.example.test/news?q={q}',
    paramMap: { q: 'q' },
    extractor: (data: any) => `新闻: ${JSON.stringify(data)}`,
    complianceDomain: 'none', needsCredential: false,
    description: '资讯聚合', securityLevel: 'safe',
  });
  const report = await runTestPipeline(getStagedTestableTool(cand.name)!);
  const sub = await submitForApproval(null, cand.name, report);
  await decideApproval(sub.approvalId!, 'approved', 'e2e');
  check('v1.0.0 上线', toolRegistry.get(cand.name)?.name === cand.name);

  // 升级 v2.0.0：端点指向不可达域名（.test TLD 永不解析）→ 冒烟失败 → 自动回滚
  const up = upgradeTool(cand.name, {
    toolName: cand.name, serviceName: cand.name, origin: cand.origin,
    endpointTemplate: 'https://broken.test.example.fail/v2?q={q}',
    paramMap: { q: 'q' },
    extractor: (data: any) => `v2: ${JSON.stringify(data)}`,
    complianceDomain: 'none', needsCredential: false,
    description: 'v2 升级测试', securityLevel: 'safe',
  }, '2.0.0', { name: cand.name, serviceName: cand.name, securityLevel: 'safe', source: 'api', origin: cand.origin });
  check('升级注册成功', up.ok, up.message);

  // 等待冒烟回滚（异步 ~1-2s）
  await new Promise(r => setTimeout(r, 3500));
  const versions = listAdapterVersions(cand.name);
  check('冒烟失败自动回滚（回到 v1.0.0）', versions.length === 1 && versions[0].version === '1.0.0', JSON.stringify(versions));
  const audit = await listAudit();
  check('审计含 rollback', audit.some(e => e.action === 'rollback' && e.subject === cand.name));
  const alive = toolRegistry.get(cand.name);
  check('回滚后工具仍在线', !!alive);
}

// ═══════════ 场景 8：网络降级异常 ═══════════
async function scene8() {
  console.log('\n━━━ 场景8：网络降级（5xx 重试 / 超时 / SSRF / 截断） ━━━');
  const { createSandboxProject, iterateTsc } = await import('./server/skills_extension/sandbox');
  const { loadSandboxTool } = await import('./server/skills_extension/test_pipeline');
  const { registerMockEndpoint, restoreFetch } = await import('./server/skills_extension/test_pipeline');

  // 1) 5xx 重试降级（适配器风格 handler 由测试流水线覆盖；这里验证沙箱模板行为）
  const proj = await createSandboxProject({
    gap: { id: 'gap_deg', keyword: '股票', evidence: ['查股票'], frequency: 4, lastSeenAt: new Date().toISOString(), status: 'pending', createdAt: new Date().toISOString() },
    endpointTemplate: 'https://api.example.test/quote2?code={code}',
    description: '股票报价', parameters: { code: { type: 'string', description: '代码' } },
    paramMap: { code: 'code' },
    extractorFn: 'const d = data as any; return "现价 " + d.price;',
    complianceDomain: 'finance', securityLevel: 'safe',
  });
  await iterateTsc(proj.id);
  const tool = (await loadSandboxTool(proj.id))!;

  registerMockEndpoint({ url: tool.endpointTemplate, status: 503 });
  const r503 = await tool.handler({});
  check('5xx 重试后降级文案', r503.startsWith('⚠️') && r503.includes('503'), r503.slice(0, 60));
  registerMockEndpoint({ url: tool.endpointTemplate, abort: true });
  const rTo = await tool.handler({});
  check('超时降级文案', rTo.startsWith('⚠️') && rTo.includes('超时'), rTo.slice(0, 60));

  // 2) SSRF 拦截：端点模板指向内网 → 请求被沙箱拦截（fetch 之前）
  const evil = await createSandboxProject({
    gap: { id: 'gap_evil', keyword: '内网', evidence: ['x'], frequency: 1, lastSeenAt: new Date().toISOString(), status: 'pending', createdAt: new Date().toISOString() },
    endpointTemplate: 'http://127.0.0.1:8080/{path}',
    description: 'SSRF 探测', parameters: { path: { type: 'string', description: 'path' } },
    paramMap: { path: 'path' },
    extractorFn: 'return JSON.stringify(data);',
    complianceDomain: 'none', securityLevel: 'safe',
  });
  await iterateTsc(evil.id);
  const evilTool = (await loadSandboxTool(evil.id))!;
  const rEvil = await evilTool.handler({ path: 'admin' });
  check('内网地址被 SSRF 拦截', rEvil.includes('拦截') || rEvil.includes('仅允许 HTTPS'), rEvil.slice(0, 80));

  // 3) 响应截断（1MB body → 输出 ≤200KB）
  const bigBody = 'x'.repeat(1_000_000);
  registerMockEndpoint({ url: tool.endpointTemplate, body: { price: bigBody } });
  const rBig = await tool.handler({});
  check('响应超长截断（≤200KB）', rBig.length <= 210_000, `len=${rBig.length}`);
  check('截断标记存在', rBig.includes('截断'));

  restoreFetch();
}

// ═══════════ 执行 ═══════════
const { initSkillsExtension } = await import('./server/skills_extension/index');
await initSkillsExtension();
console.log('阶段三 E2E：隔离环境', TMP);

await scene1();
await scene2();
const scene3Project = await scene3();
void scene3Project;
await scene4();
await scene5();
await scene6();
await scene7();
await scene8();

// 收尾：过期清理最终一致性
const { expireStaleApprovals } = await import('./server/skills_extension/approval');
await expireStaleApprovals(0);
const { listAudit } = await import('./server/skills_extension/database');
const audit = await listAudit(500);
check('全局审计链完整（≥8 类动作）', ['gap_detected', 'search', 'adapt', 'sandbox_generate', 'test', 'approve', 'reject', 'deploy', 'rollback'].every(a => audit.some(e => e.action === a)), audit.map(e => e.action).slice(0, 20).join(','));

console.log(`\n════════ 阶段三 E2E 结果：${passed} 通过 / ${failed.length} 失败 ════════`);
if (failed.length > 0) {
  console.log('失败项：');
  failed.forEach(f => console.log('  ❌ ' + f));
  process.exit(1);
}
console.log('✅ 阶段三 E2E 全部通过');
