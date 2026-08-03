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

// 复制 proactive 目录到 dist-server
const srcProactive = join(process.cwd(), 'server/proactive');
const destProactive = join(process.cwd(), 'dist-server/proactive');
try {
  cpSync(srcProactive, destProactive, { recursive: true, force: true });
  // 编译 proactive 目录中的 TypeScript 文件
  execSync('npx tsc dist-server/proactive/*.ts --outDir dist-server/proactive --module commonjs --target es2020 --esModuleInterop', { stdio: 'inherit' });
  console.log('[build-server] Copied and compiled proactive/ to dist-server/');
} catch (e) {
  console.log('[build-server] proactive/ not found, skipping');
}

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
