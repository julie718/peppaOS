// server/lib/mcp_stdout_shim.mjs
// MCP 子进程 stdout 洁净垫片（Bug 修复：普通日志污染 MCP JSON-RPC 协议流）
//
// 背景：MCP stdio 协议以 stdout 承载 JSON-RPC 报文，子进程任何非协议输出都会破坏
// JSON 解析，导致工具注册/调用失败（meituan-stock-price、stock-price-query、
// comprehensive-markdown-scraper、voice-module-status-check 均死于 console.log 污染）。
//
// 机制：加载器（server/mcp/client.ts connectServerInternal）为每个 stdio 子进程注入
// NODE_OPTIONS=--import=<本文件>，本模块在任何技能代码执行前全局重定向
// console.log / console.warn / console.info → stderr（MCP SDK 协议输出走
// process.stdout 直写，不受 console 重定向影响；process.stdout 本身绝不重写）。
//
// 注意：本文件为 .mjs（纯 ESM），不依赖任何包，可被 node --import 直接预加载。

console.log = (...args) => console.error('[skill-stdout]', ...args);
console.info = (...args) => console.error('[skill-stdout:info]', ...args);
console.warn = (...args) => console.error('[skill-stdout:warn]', ...args);
// console.error / console.debug 原本就走 stderr，无需处理；
// console.table / console.dir 默认走 stdout → 一并重定向
console.table = (...args) => console.error('[skill-stdout:table]', ...args);
console.dir = (...args) => console.error('[skill-stdout:dir]', ...args);
