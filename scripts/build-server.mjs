import { build } from 'esbuild';
import { writeFileSync, mkdirSync, cpSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

await build({
  entryPoints: ['server.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: 'dist-server/server.mjs',
  external: ['sqlite3', 'sharp', '@img/sharp-win32-x64', '@img/sharp-libvips-win32-x64', 'lightningcss', 'playwright-core'],
  banner: {
    js: "import { createRequire as __peppaCreateRequire } from 'module'; const require = __peppaCreateRequire(import.meta.url);",
  },
});

// 【Phase3 P1阻断项修复·方案A】沙箱隔离子进程入口独立打包。
// 子进程由 sandbox_host 通过 child_process.fork 按文件路径拉起，不能引用主 bundle 内部模块，
// 必须产出独立产物 dist-server/sandbox_child.mjs（开发环境则直接 fork TS 入口并经 tsx 加载）。
await build({
  entryPoints: ['server/skills_extension/sandbox_isolate/sandbox_child.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: 'dist-server/sandbox_child.mjs',
  external: ['sqlite3', 'sharp', '@img/sharp-win32-x64', '@img/sharp-libvips-win32-x64', 'lightningcss', 'playwright-core'],
  banner: {
    js: "import { createRequire as __peppaCreateRequire } from 'module'; const require = __peppaCreateRequire(import.meta.url);",
  },
});

// 【重构·模块2】proactive/ 已被 esbuild 从入口 server.ts 静态依赖图打包进 server.mjs
// （含懒加载 require('../proactive/rhythm')，验证无外部化引用），无需单独复制+编译；
// 原复制后 tsc 编译步骤因相对路径（../lib/logger 等）在 dist-server 下不存在而恒失败，
// 错误被 catch 吞掉后仅打印误导性的 "not found, skipping" —— 已移除（打包脚本属保留类别⑤，仅清理失效步骤）。

// Generate entry.cjs for CommonJS environments
mkdirSync('dist-server', { recursive: true });
writeFileSync('dist-server/entry.cjs', `// CJS entry point - dynamically imports the ESM server bundle.

// Monkey-patch child_process to hide console windows on Windows (desktop app)
if (process.platform === 'win32') {
  const cp = require('child_process');
  const origSpawn = cp.spawn;
  const origExec = cp.exec;
  const origExecSync = cp.execSync;
  const origFork = cp.fork;

  cp.spawn = function (cmd, args, opts) {
    if (!opts) opts = {};
    if (opts.windowsHide === undefined) opts.windowsHide = true;
    return origSpawn.call(this, cmd, args, opts);
  };
  cp.exec = function (cmd, opts, cb) {
    if (typeof opts === 'function') { cb = opts; opts = {}; }
    if (!opts) opts = {};
    if (opts.windowsHide === undefined) opts.windowsHide = true;
    return origExec.call(this, cmd, opts, cb);
  };
  cp.execSync = function (cmd, opts) {
    if (!opts) opts = {};
    if (opts.windowsHide === undefined) opts.windowsHide = true;
    return origExecSync.call(this, cmd, opts);
  };
  cp.fork = function (mod, args, opts) {
    if (!opts) opts = {};
    if (opts.windowsHide === undefined) opts.windowsHide = true;
    return origFork.call(this, mod, args, opts);
  };
}

import('./server.mjs').catch(err => {
  console.error('Failed to start Peppa OS server:', err);
  process.exit(1);
});
`);

if (process.platform === 'win32') {
writeFileSync('dist-server/hide-console.cjs', `// Hide console window on Windows desktop app
if (process.platform === 'win32') {
  const { exec } = require('child_process');
  exec('powershell -WindowStyle Hidden -Command ""', { windowsHide: true });
}
`);
console.log('[build-server] Generated dist-server/hide-console.cjs');
} else {
console.log('[build-server] Skipped hide-console.cjs (not Windows)');
}

console.log('[build-server] Generated dist-server/server.mjs + dist-server/entry.cjs + dist-server/hide-console.cjs');
