import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../common/styles.css';
import { App } from './App';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// The share token lives in the URL fragment; opening a different link in the same tab only changes the fragment.
window.addEventListener('hashchange', () => window.location.reload());
