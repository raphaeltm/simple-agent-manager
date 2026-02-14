import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';
import { registerAppServiceWorker } from './lib/pwa';
import { startMobileViewportSync } from './lib/mobile-viewport';
import { initErrorReporter } from './lib/error-reporter';
import { getClientErrorsApiUrl } from './lib/api';

document.documentElement.setAttribute('data-ui-theme', 'sam');

const stopViewportSync = startMobileViewportSync();
registerAppServiceWorker({ enabled: import.meta.env.PROD });
initErrorReporter(getClientErrorsApiUrl());

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    stopViewportSync();
  });
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
