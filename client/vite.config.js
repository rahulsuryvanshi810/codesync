import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In development the Vite dev server proxies API and WebSocket traffic to the Node
// server, so the browser sees a single origin, just like in production.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3001',
      '/ws': { target: 'ws://localhost:3001', ws: true },
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: { codemirror: ['codemirror', '@codemirror/state', '@codemirror/view'] },
      },
    },
  },
});
