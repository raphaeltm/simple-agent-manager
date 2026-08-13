import './styles.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App';

const root = document.getElementById('root');
if (!root) throw new Error('Architecture viewer root element is missing.');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>
);
