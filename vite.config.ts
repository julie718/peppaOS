import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { defineConfig, loadEnv } from 'vite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '');
  const target = env.LUMI_TARGET || (['desktop', 'web', 'mobile', 'all'].includes(mode) ? mode : 'desktop');
  const inputs: Record<string, string> = target === 'web'
    ? { web: 'index.web.html', org: 'index.org.html' }
    : target === 'mobile'
      ? { mobile: 'index.mobile.html' }
      : target === 'all'
        ? { desktop: 'index.html', web: 'index.web.html', mobile: 'index.mobile.html', org: 'index.org.html', minimal: 'index.minimal.html' }
        : { desktop: 'index.html' };
  const outDir = target === 'all' ? 'dist' : `dist/${target}`;

  return {
    plugins: [
      react(),
      tailwindcss(),
      {
        name: 'peppa-platform-html-output',
        writeBundle() {
          const htmlName = target === 'web'
            ? 'index.web.html'
            : target === 'mobile'
              ? 'index.mobile.html'
              : '';
          if (!htmlName) return;
          const source = path.join(__dirname, outDir, htmlName);
          const dest = path.join(__dirname, outDir, 'index.html');
          if (fs.existsSync(source)) {
            fs.copyFileSync(source, dest);
            fs.rmSync(source);
          }
        },
      },
    ],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify—file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      allowedHosts: ['lumiai.asia', '.lumiai.asia'],
      watch: {
        ignored: ['**/gpt-sovits-src/**', '**/data/voice_training/**', '**/*.db', '**/db.json', '**/.keys.json', '**/data/**', '**/server/mcp/config.json'],
      },
    },
    build: {
      outDir,
      rollupOptions: {
        input: inputs,
        output: {
          manualChunks(id: string) {
            if (id.includes('node_modules/three') || id.includes('@react-three')) return 'vendor-three';
            if (id.includes('node_modules/lucide-react')) return 'vendor-icons';
            if (id.includes('node_modules/motion')) return 'vendor-motion';
            if (id.includes('node_modules/react/') || id.includes('node_modules/react-dom/')) return 'vendor-react';
          },
        },
      },
    },
    optimizeDeps: {
      exclude: ['gpt-sovits-src'],
      entries: ['./src/**/*.{tsx,ts}'],
    },
  };
});
