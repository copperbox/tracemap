import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import { initRouting } from './state/urlSync';
import './theme/global.css';

// Bind the store to the URL before first paint so deep-linked reloads render
// the right view immediately instead of flashing the default map.
initRouting();

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
