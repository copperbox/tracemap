import { defineConfig, type ProxyOptions } from 'vite';
import react from '@vitejs/plugin-react';

const target = process.env.API_PROXY_TARGET ?? 'http://127.0.0.1:4000';

// One proxy table for the dev server and for `vite preview`.
const apiProxy: Record<string, ProxyOptions> = {
  // The live notice stream must reach the browser event by event: ask the
  // API not to compress it (a gzip stream holds bytes until a block fills),
  // never time it out, and tell anything downstream not to buffer.
  '/api/live': {
    target,
    changeOrigin: true,
    timeout: 0,
    proxyTimeout: 0,
    configure: (proxy) => {
      proxy.on('proxyReq', (req, inc) => {
        if (inc.url?.split('?')[0] === '/api/live') req.setHeader('accept-encoding', 'identity');
      });
      proxy.on('proxyRes', (res) => {
        if (String(res.headers['content-type'] ?? '').startsWith('text/event-stream')) {
          res.headers['cache-control'] = 'no-cache, no-transform';
          res.headers['x-accel-buffering'] = 'no';
        }
      });
    },
  },
  '/api': {
    target,
    changeOrigin: true,
  },
};

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: apiProxy },
  // `npm run build && npm run preview` serves the production bundle against
  // the same API: the fair way to judge how the UI performs.
  preview: { port: 4173, proxy: apiProxy },
  test: {
    environment: 'node',
  },
} as never);
