import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './ui/App.js';
import { ErrorBoundary } from './ui/ErrorBoundary.js';
import { EnvBanner } from './ui/EnvBanner.js';
import '@xyflow/react/dist/style.css';
import './ui/styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <EnvBanner />
    <ErrorBoundary variant="page" label="app" message="Algo ha fallado al cargar la aplicación — recargar">
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
