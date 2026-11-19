import { defineConfig } from 'vite';

// dev-server proxy: only used by `vite dev`, never shipped
export default defineConfig({
  server: { proxy: { '/api': { target: 'http://127.0.0.1:3001', changeOrigin: false } } },
});
