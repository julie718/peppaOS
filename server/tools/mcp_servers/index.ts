// 阶段一·模块1: 5 套标准 MCP 汇总注册 — 全部双形态（ToolRegistry 直调 + McpServer 工厂）
// 统一架构：所有工具先注册进 ToolRegistry（chat 直调走统一工具路由），
// 同时提供 createXxxMcpServer() 工厂（符合 MCP 协议的外部挂载形态）。底层逻辑完全复用，不重复编码。
import { ToolRegistry } from '../registry';
import { registerTravelTools, createTravelCalMcpServer } from './travel_cal';
import { registerWebSearchTools, createWebSearchMcpServer } from './web_search';
import { registerStockTools, createStockFinMcpServer } from './stock_fin';
import { registerNotifyTools, createNotifyMcpServer } from './notify';
import { registerUtilTools, createUtilMcpServer } from './util';

export function registerMcpServers(registry: ToolRegistry): void {
  registerTravelTools(registry);
  registerWebSearchTools(registry);
  registerStockTools(registry);
  registerNotifyTools(registry);
  registerUtilTools(registry);
}

export { createTravelCalMcpServer, createWebSearchMcpServer, createStockFinMcpServer, createNotifyMcpServer, createUtilMcpServer };
export { pushUpcomingTravelInfo } from './travel_cal';
export { MUST_SEARCH_TERMS } from './web_search';
