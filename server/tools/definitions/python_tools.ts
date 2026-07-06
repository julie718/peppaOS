import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { ToolRegistry } from '../registry';

const OUTPUT_DIR = path.join(process.cwd(), 'peppa_output');
const IMAGE_EXTS = /\.(png|jpg|jpeg|svg|gif|webp)$/i;

function ensureOutputDir() {
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

function snapshotImages(): Set<string> {
  return new Set(fs.readdirSync(OUTPUT_DIR).filter(f => IMAGE_EXTS.test(f)));
}

function detectNewImages(before: Set<string>): string[] {
  const after = fs.readdirSync(OUTPUT_DIR).filter(f => IMAGE_EXTS.test(f));
  return after.filter(f => !before.has(f));
}

function formatImages(images: string[]): string {
  return images.map(img => {
    const stat = fs.statSync(path.join(OUTPUT_DIR, img));
    const sizeKB = (stat.size / 1024).toFixed(1);
    return `![${img}](/peppa_output/${img})\n*${img} · ${sizeKB} KB*`;
  }).join('\n\n');
}

const WRAP_HEADER = `import matplotlib
matplotlib.use('Agg')
import os
os.environ['MPLBACKEND'] = 'Agg'
_output_dir = r"${OUTPUT_DIR.replace(/\\/g, '\\\\')}"
os.chdir(_output_dir)

`;

async function pythonExec(args: Record<string, any>): Promise<string> {
  const code = String(args.code || '');
  const timeout = Math.min(Math.max(Number(args.timeout) || 30000, 5000), 120000);
  if (!code.trim()) throw new Error('Code is required.');

  ensureOutputDir();
  const before = snapshotImages();

  const scriptId = `py_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const scriptPath = path.join(OUTPUT_DIR, `${scriptId}.py`);
  fs.writeFileSync(scriptPath, WRAP_HEADER + code, 'utf-8');

  try {
    const stdout = execSync(`python "${scriptPath}"`, {
      timeout,
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env, MPLBACKEND: 'Agg', PYTHONIOENCODING: 'utf-8' },
      windowsHide: true,
    });

    const newImages = detectNewImages(before);
    const parts: string[] = [];
    if (stdout.trim()) parts.push(stdout.trim());
    if (newImages.length > 0) parts.push(formatImages(newImages));
    if (parts.length === 0) parts.push('(Code executed successfully with no output)');
    return parts.join('\n\n');
  } catch (err: any) {
    const newImages = detectNewImages(before);
    const errorMsg = err.stderr || err.message || String(err);
    const parts: string[] = [`**Error:**\n\`\`\`\n${errorMsg.slice(0, 2000)}\n\`\`\``];
    if (err.stdout?.trim()) parts.push(`**Output:**\n\`\`\`\n${err.stdout.trim().slice(0, 2000)}\n\`\`\``);
    if (newImages.length > 0) parts.push(formatImages(newImages));
    return parts.join('\n\n');
  } finally {
    try { fs.unlinkSync(scriptPath); } catch {}
  }
}

async function pythonPackageInstall(args: Record<string, any>): Promise<string> {
  const pkg = String(args.package || '').trim();
  if (!pkg) throw new Error('Package name is required.');

  const safePkg = /^[a-zA-Z0-9_.-]+$/.test(pkg) ? pkg : null;
  if (!safePkg) throw new Error(`Invalid package name: ${pkg}`);

  try {
    const stdout = execSync(`pip install "${safePkg}"`, {
      timeout: 60000,
      encoding: 'utf-8',
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    });
    const already = stdout.includes('already satisfied') ? ' (already installed)' : '';
    return `Package \`${safePkg}\` installed successfully${already}.\n\`\`\`\n${stdout.trim().slice(-800)}\n\`\`\``;
  } catch (err: any) {
    const msg = err.stderr || err.message || String(err);
    throw new Error(`Failed to install ${safePkg}: ${msg}`);
  }
}

export function registerPythonTools(registry: ToolRegistry): void {
  registry.register({
    name: 'python_exec',
    description:
      'Execute Python 3.10 code with matplotlib, seaborn, plotly, pandas, and Pillow available. Use this to generate charts, plots, data visualizations, statistical graphics, and image processing. To display a chart in chat, save it with `plt.savefig(\'filename.png\')` — saved images are automatically captured and shown. The matplotlib backend is already set to Agg (no GUI needed). Working directory is peppa_output/. Use `plt.savefig(\'chart.png\', dpi=100, bbox_inches=\'tight\')` for best results. For plotly, use `fig.write_image(\'chart.png\')` or `fig.write_html(\'chart.html\')`.',
    parameters: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'Python code to execute. Import what you need — matplotlib, seaborn, pandas, plotly, and PIL are available.' },
        timeout: { type: 'number', description: 'Timeout in milliseconds (default 30000, max 120000).' },
      },
      required: ['code'],
    },
    handler: pythonExec,
    permission: 'user',
    securityLevel: 'confirm',
  });

  registry.register({
    name: 'python_pip_install',
    description:
      'Install a Python package via pip. Use this when the user needs a library that is not already available (matplotlib, seaborn, plotly, pandas, and Pillow are pre-installed).',
    parameters: {
      type: 'object',
      properties: {
        package: { type: 'string', description: 'The pip package name to install.' },
      },
      required: ['package'],
    },
    handler: pythonPackageInstall,
    permission: 'user',
    securityLevel: 'confirm',
  });
}
