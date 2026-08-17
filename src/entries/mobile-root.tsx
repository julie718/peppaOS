import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AppProvider } from '../contexts/AppContext';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { MobileApp } from './mobile';
import { Health } from '@krzysztofkostecki/capacitor-health';
import { ensureConfiguredOrigin } from '../config/remoteConfig';

// 启动二次校验：页面 origin 与服务器配置 apiBase 不一致时整页重定向
// （iOS 原生侧已在 WebView 加载前完成一次解析，正常情况这里为 no-op）
void ensureConfiguredOrigin();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <AppProvider>
        <MobileApp />
      </AppProvider>
    </ErrorBoundary>
  </StrictMode>,
);
