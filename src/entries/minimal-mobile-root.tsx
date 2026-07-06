import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AppProvider } from '../contexts/AppContext';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { MinimalChat } from '../components/MinimalChat';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <AppProvider>
        <MinimalChat />
      </AppProvider>
    </ErrorBoundary>
  </StrictMode>,
);
