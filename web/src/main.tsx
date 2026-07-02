import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import { useStore } from './state/store';
import { initRouting } from './state/urlSync';
import './theme/global.css';

// Bind the store to the URL before first paint so deep-linked reloads render
// the right view immediately instead of flashing the default map.
initRouting();

// index.html hardcodes data-theme="dark"; apply the persisted preference before
// first paint so a light-theme user doesn't get a dark flash.
document.body.setAttribute('data-theme', useStore.getState().theme);

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
