// Auto-detect platform: Tauri → desktop, otherwise → web
// Mobile can be added later: Capacitor → mobile
import { StrictMode, lazy, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { AppProvider } from '../contexts/AppContext';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { LoadingFallback } from '../components/LoadingFallback';
import { installApiBridge } from '../services/apiBridge';
import '@fontsource-variable/geist';
import '../index.css';

installApiBridge();

const isTauri = !!(window as any).__TAURI_INTERNALS__ || !!(window as any).__TAURI_IPC__ || !!(window as any).__TAURI__;

const DesktopApp = lazy(() => import('./desktop').then(m => ({ default: m.DesktopApp })));
const WebApp = lazy(() => import('./web').then(m => ({ default: m.WebApp })));

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <AppProvider>
        <Suspense fallback={<LoadingFallback />}>
          {isTauri ? <DesktopApp /> : <WebApp />}
        </Suspense>
      </AppProvider>
    </ErrorBoundary>
  </StrictMode>,
);
