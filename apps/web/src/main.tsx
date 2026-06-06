import './app.css';
import './index.css';

import React from 'react';
import ReactDOM from 'react-dom/client';

import App from './App';
import { applyThemeAttribute, readStoredTheme } from './contexts/ThemeContext';
import { initAnalytics } from './lib/analytics';
import { getAnalyticsApiUrl,getClientErrorsApiUrl } from './lib/api';
import { initErrorReporter } from './lib/error-reporter';
import { startMobileViewportSync } from './lib/mobile-viewport';
import { registerAppServiceWorker } from './lib/pwa';

// Pre-paint theme init: apply the persisted theme (default dark) before first
// render so there is no flash of the wrong theme (FOUC).
applyThemeAttribute(readStoredTheme());

const stopViewportSync = startMobileViewportSync();
registerAppServiceWorker({ enabled: import.meta.env.PROD });
initErrorReporter(getClientErrorsApiUrl());
initAnalytics(getAnalyticsApiUrl());

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
