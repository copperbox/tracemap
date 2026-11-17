import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const target = process.env.API_PROXY_TARGET ?? 'http://127.0.0.1:4000';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
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
    },
  },
  test: {
    environment: 'node',
  },
} as never);
