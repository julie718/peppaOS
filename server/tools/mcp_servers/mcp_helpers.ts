// 阶段一·模块1: 标准 MCP 工厂共享构建器（与 peppa-mcp 同构）
// 所有 createXxxMcpServer 统一走这里：capabilities 第二参数 + zod inputSchema，
// 避免 5 套 MCP 各自重复实现工厂逻辑（红线③统一改造复用）。
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ToolRegistry } from '../registry';

/** JSON Schema properties → zod shape（peppa-mcp 同构风格） */
export function paramsToShape(properties: Record<string, any> = {}, required: string[] = []): Record<string, any> {
  const shape: Record<string, any> = {};
  for (const [k, v] of Object.entries(properties || {})) {
    let t: any = z.any();
    if (v?.type === 'string') t = z.string();
    else if (v?.type === 'number') t = z.number();
    else if (v?.type === 'boolean') t = z.boolean();
    if (v?.description) t = t.describe(v.description);
    if (!required.includes(k)) t = t.optional();
    shape[k] = t;
  }
  return shape;
}

/** 从已注册的 ToolRegistry 构建标准 MCP 服务器（工具全部来自同一注册表，零重复编码） */
export function buildMcpServerFromRegistry(name: string, version: string, registry: ToolRegistry, toolNames: string[]): McpServer {
  const mcp = new McpServer({ name, version }, { capabilities: { tools: {} } });
  for (const n of toolNames) {
    const def = registry.get(n);
    if (!def) continue;
    mcp.registerTool(
      n,
      {
        title: def.description,
        description: def.description,
        inputSchema: paramsToShape((def.parameters as any)?.properties || {}, (def.parameters as any)?.required || []),
      },
      async (args: any) => {
        const out = await def.handler({ ...args, userId: process.env.E2E_UID || 'peppa-user' });
        return { content: [{ type: 'text', text: out }] };
      },
    );
  }
  return mcp;
}
