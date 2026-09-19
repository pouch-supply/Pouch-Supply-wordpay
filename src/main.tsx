import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import { ErrorBoundary } from './components/ErrorBoundary.tsx';
import { installAdminFetch, installCustomerSessionCapture } from './lib/adminApi.ts';
import './index.css';

// Installed before React mounts so the very first request already carries the
// token — App.tsx starts fetching during its initial effects. Capture wraps the
// header wrapper, so a sign-in response is read on the way back out.
installAdminFetch();
installCustomerSessionCapture();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);

