import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';

const backendPort = Number(process.env.GCT_PORT ?? 17840);
const frontendPort = Number(process.env.GCT_FRONTEND_PORT ?? 5173);
const releaseVersion = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version as string;

export default defineConfig({
  plugins: [react()],
  define: {
    'import.meta.env.VITE_APP_VERSION': JSON.stringify(releaseVersion),
  },
  server: {
    host: '127.0.0.1',
    port: frontendPort,
    strictPort: true,
    proxy: {
      '/health': `http://127.0.0.1:${backendPort}`,
      '/api': `http://127.0.0.1:${backendPort}`,
      '/secure': `http://127.0.0.1:${backendPort}`,
      '/ws': { target: `ws://127.0.0.1:${backendPort}`, ws: true },
    },
  },
});
