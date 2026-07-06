/**
 * Rename peppa → peppa across the entire codebase.
 *
 * Usage:
 *   node scripts/rename-peppa-to-peppa.mjs --dry-run   (preview only)
 *   node scripts/rename-peppa-to-peppa.mjs              (execute)
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const DRY_RUN = process.argv.includes('--dry-run');

// ── Directories to skip ──────────────────────────────────────────
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.claude', 'dist', 'dist-server',
  'target', 'android', 'ios', '.DS_Store',
]);

// ── File extensions to process ───────────────────────────────────
const INCLUDE_EXT = new Set([
  '.ts', '.tsx', '.js', '.mjs', '.cjs', '.json', '.html',
  '.css', '.py', '.sh', '.ps1', '.md', '.toml', '.yml', '.yaml',
  '.xml', '.plist', '.conf',
]);

// ── Replacement rules (order matters: longer/specific first) ─────
const RULES = [
  // File content replacements — regex-based with word boundaries
  { pattern: /\bLumiOS\b/g,      replacement: 'PeppaOS' },
  { pattern: /\blumiOS\b/g,      replacement: 'peppaOS' },
  { pattern: /\bLumi\b/g,        replacement: 'Peppa' },
  { pattern: /\blumi\b/g,        replacement: 'peppa' },
  // Also catch "peppa" inside localStorage keys like "peppa_auth_token"
  // These don't have word boundaries around underscores, so handle separately
  { pattern: /'peppa_/g,          replacement: "'peppa_" },
  { pattern: /"peppa_/g,          replacement: '"peppa_' },
  { pattern: /`peppa_/g,          replacement: '`peppa_' },
  { pattern: /\/peppa_/g,         replacement: '/peppa_' },
  // CustomEvent names
  { pattern: /peppa:/g,           replacement: 'peppa:' },
];

// ── Collect files ─────────────────────────────────────────────────
function walk(dir) {
  const results = [];
  try {
    for (const entry of fs.readdirSync(dir)) {
      if (SKIP_DIRS.has(entry)) continue;
      const full = path.join(dir, entry);
      const stat = fs.statSync(full);
      if (stat.isDirectory()) {
        results.push(...walk(full));
      } else if (INCLUDE_EXT.has(path.extname(entry))) {
        results.push(full);
      }
    }
  } catch {}
  return results;
}

// ── Helper: apply rules to file content ───────────────────────────
function transform(content, filePath) {
  let changed = false;
  for (const rule of RULES) {
    const before = content;
    content = content.replace(rule.pattern, rule.replacement);
    if (content !== before) changed = true;
  }
  return { content, changed };
}

// ── Main ──────────────────────────────────────────────────────────
const files = walk(ROOT);
console.log(`Found ${files.length} processable files\n`);

let totalChanges = 0;
let filesChanged = 0;

for (const file of files) {
  const rel = path.relative(ROOT, file);
  const original = fs.readFileSync(file, 'utf-8');
  const { content, changed } = transform(original, file);

  if (changed) {
    filesChanged++;

    // Count lines changed
    const origLines = original.split('\n');
    const newLines = content.split('\n');
    let lineChanges = 0;
    for (let i = 0; i < Math.max(origLines.length, newLines.length); i++) {
      if (origLines[i] !== newLines[i]) lineChanges++;
    }

    if (DRY_RUN) {
      console.log(`\n📄 ${rel}  (${lineChanges} lines changed)`);
      // Show first 3 changed lines as preview
      let shown = 0;
      for (let i = 0; i < origLines.length && shown < 3; i++) {
        if (origLines[i] !== newLines[i]) {
          console.log(`   L${i+1}: "${origLines[i].trim().slice(0,60)}"`);
          console.log(`      → "${newLines[i].trim().slice(0,60)}"`);
          shown++;
        }
      }
    } else {
      fs.writeFileSync(file, content, 'utf-8');
    }
    totalChanges += lineChanges;
  }
}

console.log(`\n${'='.repeat(60)}`);
if (DRY_RUN) {
  console.log(`[DRY-RUN] Would modify ${filesChanged} files, ${totalChanges} lines`);
  console.log(`To execute: node scripts/rename-peppa-to-peppa.mjs`);
} else {
  console.log(`[DONE] Modified ${filesChanged} files, ${totalChanges} lines`);
}
