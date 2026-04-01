import './app.css';
import './index.css';

import React from 'react';
import ReactDOM from 'react-dom/client';

import App from './App';
import { initAnalytics } from './lib/analytics';
import { getAnalyticsApiUrl,getClientErrorsApiUrl } from './lib/api';
import { initErrorReporter } from './lib/error-reporter';
import { startMobileViewportSync } from './lib/mobile-viewport';
import { registerAppServiceWorker } from './lib/pwa';

document.documentElement.setAttribute('data-ui-theme', 'sam');

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
