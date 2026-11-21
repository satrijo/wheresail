import { defineConfig } from 'vite';

export default defineConfig({
  // Served under /app/ behind the landing page at / — relative asset paths
  // keep the demo working at any subpath.
  base: './',
  server: {
    port: 5173,
    host: '127.0.0.1',
  },
});
