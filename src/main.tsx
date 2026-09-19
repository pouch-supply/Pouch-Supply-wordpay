import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import { ErrorBoundary } from './components/ErrorBoundary.tsx';
import { installAdminFetch } from './lib/adminApi.ts';
import './index.css';

// Installed before React mounts so the very first admin request already carries
// the token — App.tsx starts fetching during its initial effects.
installAdminFetch();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);

