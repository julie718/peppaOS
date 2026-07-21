import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AppProvider } from '../contexts/AppContext';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { MobileApp } from './mobile';
import { Health } from '@krzysztofkostecki/capacitor-health';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <AppProvider>
        <MobileApp />
      </AppProvider>
    </ErrorBoundary>
  </StrictMode>,
);
