import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import '@simple-agent-manager/ui/tokens/theme.css';

document.documentElement.setAttribute('data-ui-theme', 'sam');

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
