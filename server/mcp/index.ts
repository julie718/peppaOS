export { mcpManager, SKILLS_DIR } from './client';
export type { MCPServerConfig, MCPToolDef, SkillPackage } from './client';

import { toolRegistry } from '../tools/registry';
import { logger } from '../lib/logger';
import { mcpManager, MCPToolDef, MCPServerConfig } from './client';
import type { ToolDefinition, ToolContext } from '../tools/types';

/**
 * Register all discovered MCP tools into our tool registry.
 * Each MCP tool gets prefixed: mcp_{serverName}_{toolName}
 */
export async function registerMCPTools(io?: any): Promise<string[]> {
  if (io) mcpManager.setSocketIO(io);

  const mcpTools = await mcpManager.connectAll();
  const registered: string[] = [];

  for (const tool of mcpTools) {
    registerTool(tool);
    registered.push(tool.name);
  }

  mcpManager.setOnServerRecovered(recoverServerTools);
  // Bug 修复：崩溃即注销该 server 的注册工具（计数不再虚高，注册集合稳定）
  mcpManager.setOnServerCrashed((name) => {
    toolRegistry.unregisterByPrefix(`mcp_${name}_`);
  });

  // Bug 修复：启动输出完整工具清单日志（此前仅按 server 打印计数，无法核对注册集合是否稳定）
  logger.info(`[MCP] 启动工具注册完成: 共 ${registered.length} 个工具 — ${registered.join(', ')}`);

  return registered;
}

function registerTool(tool: MCPToolDef): void {
  const def: ToolDefinition = {
    name: tool.name,
    description: tool.description || `MCP tool: ${tool.name}`,
    permission: 'public',
    securityLevel: 'confirm',
    parameters: mcpSchemaToParams(tool.inputSchema),
    handler: async (params: Record<string, any>, _ctx: ToolContext) => {
      return mcpManager.callTool(tool.name, params);
    },
  };
  toolRegistry.register(def);
}

export async function recoverServerTools(name: string, tools: MCPToolDef[]): Promise<string[]> {
  const prefix = `mcp_${name}_`;
  toolRegistry.unregisterByPrefix(prefix);

  const registered: string[] = [];
  for (const tool of tools) {
    registerTool(tool);
    registered.push(tool.name);
  }
  logger.info(`[MCP] Re-registered ${registered.length} tools for recovered server "${name}"`);
  return registered;
}

/**
 * Get MCP server config (for listing in UI)
 */
export function getMCPConfig(): Record<string, MCPServerConfig> {
  return mcpManager.getConfig();
}

/**
 * Update MCP server config and reconnect
 */
export async function updateMCPConfig(servers: Record<string, MCPServerConfig>): Promise<string[]> {
  mcpManager.saveConfig(servers);
  return registerMCPTools();
}

function mcpSchemaToParams(schema: Record<string, any>): Record<string, any> {
  if (!schema || !schema.properties) return {};

  const params: Record<string, any> = {};
  for (const [key, prop] of Object.entries(schema.properties) as [string, any][]) {
    params[key] = {
      type: prop.type || 'string',
      description: prop.description || '',
      required: (schema.required || []).includes(key),
    };
  }

  return params;
}
