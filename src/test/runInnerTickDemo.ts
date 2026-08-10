// src/test/runInnerTickDemo.ts
// 阶段1：InnerTick 独立心智回合 — 开发者手动调试脚本（独立运行，不接入业务链路）
// 运行方式: npx tsx src/test/runInnerTickDemo.ts
// 行为: 调用 runInnerTick() 执行一轮 LLM 心智推演，打印输出，快照已写入 life.db。
// 注意: 本脚本不会修改任何全局运行状态；仅独立组件手动验证用。

import { runInnerTick } from '../core/innerTick';
// 向量记忆（addMemory）依赖 JSON 内存库，需与 server 启动流程一致先初始化
import { initDatabase } from '../../db_layer';

async function main() {
  const userId = process.env.INNERTICK_USER_ID || 'default';
  console.log('[InnerTickDemo] ========== 开始 InnerTick 心智回合演示 ==========');
  console.log(`[InnerTickDemo] userId=${userId}`);

  // 初始化 JSON 内存库（server.ts 启动时同样调用；此处仅为本独立脚本可用）
  try {
    await initDatabase();
    console.log('[InnerTickDemo] 内存库初始化完成');
  } catch (e: any) {
    console.warn(`[InnerTickDemo] 内存库初始化失败: ${e?.message}`);
  }

  try {
    const output = await runInnerTick({ userId });

    console.log('\n[InnerTickDemo] ========== InnerTickOutput ==========');
    console.log(`思考(thought): ${output.thought}`);
    console.log(`情绪(mood): ${output.mood.name} @ ${output.mood.intensity.toFixed(2)}`);
    console.log(`欲望(desires): ${output.desires.length} 条`);
    for (const d of output.desires) {
      console.log(`  - [${d.status}] ${d.content} (${d.intensity.toFixed(2)})`);
    }
    console.log(`目标(goals): ${output.goals.length} 条`);
    for (const g of output.goals) {
      console.log(`  - [${g.status}] ${g.content}`);
    }
    console.log(`焦点(focus): ${output.focus.length} 条`);
    for (const f of output.focus) {
      console.log(`  - ${f.content}`);
    }
    console.log(`归档(archiveItems): ${output.archiveItems.length} 条`);
    for (const a of output.archiveItems) {
      console.log(`  - ${a.type}:${a.id} → ${a.reason}`);
    }
    console.log(`triggerInnerTick: ${output.triggerInnerTick}`);
    console.log(`memoryHints: ${output.memoryHints.length} 条`, output.memoryHints);

    console.log('\n[InnerTickDemo] ✅ 心智回合执行完成；完整输出已序列化写入 life.db 快照备份（system_events#inner_tick_snapshot）');
  } catch (e: any) {
    console.error('\n[InnerTickDemo] ❌ 心智回合执行失败:');
    console.error('   ', e?.message || e);
    console.error('[InnerTickDemo] 提示: 请确认 LLM provider 配置可用（DEEPSEEK_API_KEY 等环境变量），life.db 可写。');
    process.exitCode = 1;
  }
}

main();
